var urlParse = require('url').parse;
var util = require('util');
var redis = require('redis');
var timeoutAfter = require('callback-timeout');

module.exports = function(options, Source) {
    if (!Source) throw new Error('No source provided');
    if (!Source.prototype.get) throw new Error('No get method found on source');

    function Caching() { return Source.apply(this, arguments) };

    // Inheritance.
    util.inherits(Caching, Source);

    // References for testing, convenience, post-call overriding.
    Caching.redis = options;

    Caching.prototype.get = module.exports.cachingGet('TL3', options, Source.prototype.get);

    return Caching;
};

module.exports.cachingGet = function(namespace, options, get) {
    if (!get) throw new Error('No get function provided');
    if (!namespace) throw new Error('No namespace provided');

    options = options || {};
    if (options.client) {
        options.client.options.return_buffers = true;
    } else {
        options.client = redis.createClient({return_buffers: true});
    }

    if (!options.client) throw new Error('No redis client');
    var config = getConfig(options);

    return function relay(url, callback) {
        var key = namespace + '-' + url;
        var source = this;
        var client = options.client;

        // Timeout redis operations @ 50ms by default
        var timeout = options.timeout || 50;

        var ttl = 300;
        var stale = 300;

        // Match the key against ttl/stale rules to determine its value.
        for (var a = 0; a < config.ttl.length; a++) {
            if (config.ttl[a].pattern.test(key)) {
                ttl = config.ttl[a].value;
                break;
            }
        }
        for (var b = 0; b < config.stale.length; b++) {
            if (config.stale[b].pattern.test(key)) {
                stale = config.stale[b].value;
                break;
            }
        }

        if (client.command_queue.length >= client.command_queue_high_water) {
            client.emit('error', new Error('Redis command queue at high water mark'));
            return get.call(source, url, callback);
        }

        client.get(key, timeoutAfter(function redisGet(err, encoded) {
            // If error on redis get, pass through to original source
            // without attempting a set after retrieval.
            if (err) {
                err.key = key;
                client.emit('error', err);
                return get.call(source,url, callback);
            }

            // Cache hit.
            var data;
            if (encoded) try {
                data = decode(encoded);
            } catch(err) {
                err.key = key;
                client.emit('error', err);
            }
            if (data) {
                callback(data.err, data.buffer, data.headers);
                if (isFresh(data)) return;

                // Update cache & bump `expires` header
                get.call(source, url, function(err, buffer, headers) {
                    if (err && !errcode(err)) return client.emit('error', err);

                    headers = headers || {};
                    headers = setEx(key, err, buffer, headers, ttl, stale);
                });
            } else {
                // Cache miss, error, or otherwise no data
                get.call(source, url, function(err, buffer, headers) {
                    if (err && !errcode(err)) return callback(err);

                    headers = headers || {};
                    headers = setEx(key, err, buffer, headers, ttl, stale);
                    callback(err, buffer, headers);
                });
            }
        }, timeout));

        function setEx(key, err, buffer, headers, ttl, stale) {
            var expires = headers.Expires || headers.expires;
            delete headers.Expires;
            delete headers.expires;
            if (expires) {
                headers.expires = expires;
                headers['x-redis-expires'] = expires;
            } else {
                headers['x-redis-expires'] = (new Date(Date.now() + (ttl * 1000))).toUTCString();
            }

            // seconds from now to expiration time
            var sec = Math.ceil((Number(new Date(headers['x-redis-expires'])) - Number(new Date()))/1000);

            // stale is the number of extra seconds to cache an object
            // past its expires time where we may serve a "stale"
            // version of the object.
            //
            // When an upstream expires is set no stale padding is used
            // so that the upstream expires is fully respected.
            var pad = expires ? 0 : stale;

            if (sec > 0) client.setex(key, sec + pad, encode(err, buffer, headers), timeoutAfter(function redisSetEx(err) {
                if (!err) return;
                err.key = key;
                client.emit('error', err);
            }, timeout));

            return headers;
        }

        function isFresh(d) {
            // When we don't have an expires header just assume staleness
            if (d.headers === undefined || !d.headers['x-redis-expires']) return false;

            return (+(new Date(d.headers['x-redis-expires'])) > Date.now());
        }
    };
};

module.exports.redis = redis;
module.exports.encode = encode;
module.exports.decode = decode;
module.exports.getConfig = getConfig;

// Generate key matching rules for applying a specific stale or ttl value
// by key match.
function getConfig(options) {
    var config = { stale: [], ttl: [] };
    ['stale', 'ttl'].forEach(function(type) {
        options[type] = (/^(number|object)$/.test(typeof options[type])) ? options[type] : 300;
        if (!options[type]) throw new Error('No ' + type + ' option set');
        if (typeof options[type] === 'object') {
            for (var k in options[type]) {
                if (typeof options[type][k] !== 'number') {
                    throw new Error(type + '.' + k + ' is not a number');
                } else {
                    config[type].push({
                        pattern: new RegExp(k),
                        value: options[type][k]
                    });
                }
            }
        } else if (typeof options[type] === 'number') {
            config[type].push({
                pattern: new RegExp(''),
                value: options[type]
            });
        }
    });
    return config;
}

function errcode(err) {
    if (!err) return;
    if (err.statusCode === 404) return 404;
    if (err.statusCode === 403) return 403;
    return;
}

function encode(err, buffer, headers) {
    // Unhandled error.
    if (err && !errcode(err)) return null;

    headers = headers || {};

    if (err)  {
        headers['x-redis-err'] = errcode(err).toString();
        headers = new Buffer(JSON.stringify(headers), 'utf8');
        return headers;
    }

    // Turn objects into JSON string buffers.
    if (buffer && typeof buffer === 'object' && !(buffer instanceof Buffer)) {
        headers['x-redis-json'] = true;
        buffer = new Buffer(JSON.stringify(buffer));
    // Turn strings into buffers.
    } else if (buffer && !(buffer instanceof Buffer)) {
        buffer = new Buffer(buffer);
    }

    headers = new Buffer(JSON.stringify(headers), 'utf8');

    if (headers.length > 1024) {
        throw new Error('Invalid cache value - headers exceed 1024 bytes: ' + JSON.stringify(headers));
    }

    var padding = new Buffer(1024 - headers.length);
    padding.fill(' ');
    var len = headers.length + padding.length + buffer.length;
    return Buffer.concat([headers, padding, buffer], len);
};

function decode(encoded) {
    if (encoded.length == 3) {
        encoded = encoded.toString();
        if (encoded === '404' || encoded === '403') {
            var err = new Error();
            err.statusCode = parseInt(encoded, 10);
            err.redis = true;
            return { err: err };
        }
    }

    // First 1024 bytes reserved for header + padding.
    var offset = 1024;
    var data = {};
    // If 1024 or less, then it is only headers
    if (encoded.length > 1024) {
        data.headers = encoded.slice(0, offset).toString().trim();
    } else {
        data.headers = encoded;
    }

    try {
        data.headers = JSON.parse(data.headers);
    } catch(e) {
        throw new Error('Invalid cache value');
    }

    data.headers['x-redis'] = 'hit';

    if (data.headers['x-redis-err']) {
        var err = new Error();
        err.statusCode = parseInt(data.headers['x-redis-err'], 10);
        err.redis = true;
        return { err: err, headers: data.headers };
    }

    data.buffer = encoded.slice(offset);

    // Return JSON-encoded objects to true form.
    if (data.headers['x-redis-json']) data.buffer = JSON.parse(data.buffer);

    if (data.headers['content-length'] && data.headers['content-length'] != data.buffer.length)
        throw new Error('Content length does not match');
    return data;
};

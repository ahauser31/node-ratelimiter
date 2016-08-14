/**
 * Module dependencies.
 */

var assert = require('assert');

/**
 * Expose `Limiter`.
 */

module.exports = Limiter;

/**
 * Initialize a new limiter with `opts`:
 *
 *  - `id` identifier being limited
 *  - `db` redis connection instance
 *
 * @param {Object} opts
 * @api public
 */

function Limiter(opts) {
  this.id = opts.id;
  this.db = opts.db;
  assert(this.id, '.id required');
  assert(this.db, '.db required');
  this.max = opts.max || 2500;
  this.duration = opts.duration || 3600000;
  this.prefix = 'limit:' + this.id;
}

/**
 * Inspect implementation.
 *
 * @api public
 */

Limiter.prototype.inspect = function () {
  return '<Limiter id='
    + this.id + ', duration='
    + this.duration + ', max='
    + this.max + '>';
};

/**
 * Get values and header / status code and invoke `fn(err, info)`.
 *
 * redis is populated with the following keys
 * that expire after N seconds:
 *
 *  - limit:<id>:count
 *  - limit:<id>:limit
 *  - limit:<id>:reset
 *
 * @param {Function} fn
 * @api public
 */

Limiter.prototype.get = function (fn) {
  
  var db = this.db;
  var entryName = this.prefix;
  var duration = this.duration;
  
  var entry = {
      'count': this.max,
      'limit': this.max
    };

  function create() {
    entry.reset = (Date.now() + duration) / 1000 | 0;
    
    db.multi()
      .set([entryName, JSON.stringify(entry), 'PX', duration, 'NX'])
      .exec(function (err, res) {
        if (err) return fn(err);

        // If the request has failed, it means the values already
        // exist in which case we need to get the latest values.
        if (isFirstReplyNull(res)) return mget();

        fn(null, {
          total: entry.count,
          remaining: entry.limit,
          reset: entry.reset
        });
      });
  }

  function decr(res) {
    var entry = JSON.parse(res);
    var tmpEntry = JSON.parse(res);
    var dateNow = Date.now();

    if (entry.count <= 0) return done();
    
    function done() {
      fn(null, {
        total: entry.limit,
        remaining: entry.count < 0 ? 0 : entry.count,
        reset: entry.reset
      });
    }

    tmpEntry.count--;
    db.multi()
      .set([entryName, JSON.stringify(tmpEntry), 'PX', entry.reset * 1000 - dateNow, 'XX'])
      .exec(function (err, res) {
        if (err) return fn(err);
        if (isFirstReplyNull(res)) return mget();
        
        entry.count--;
        done();
      });
  }

  function mget() {    
    db.watch([entryName], function (err)
    {
      if (err) return fn(err);
      db.get(entryName, function (err, res) {
        if (err) return fn(err);
        if (res === null) return create();
      
        decr(res);
      });
    });
  }

  mget();
};

/**
 * Check whether the first item of multi replies is null,
 * works with ioredis and node_redis
 *
 * @param {Array} replies
 * @return {Boolean}
 * @api private
 */

function isFirstReplyNull(replies) {
  if (!replies) {
    return true;
  }

  return Array.isArray(replies[0]) ?
    // ioredis
    !replies[0][1] :
    // node_redis
    !replies[0];
}

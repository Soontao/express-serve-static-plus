/*!
 * send
 * Copyright(c) 2012 TJ Holowaychuk
 * Copyright(c) 2014-2022 Douglas Christopher Wilson
 * MIT Licensed
 */

/**
 * Module dependencies.
 * @private
 */

const createError = require('http-errors');
const deprecate = require('depd')('send');
const destroy = require('destroy');
const encodeUrl = require('encodeurl');
const escapeHtml = require('escape-html');
const etag = require('etag');
const fresh = require('fresh');
const fs = require('fs');
const mime = require('mime');
const ms = require('ms');
const onFinished = require('on-finished');
const parseRange = require('range-parser');
const path = require('path');
const statuses = require('statuses');
const Stream = require('stream');
const util = require('util');
const debug = util.debug("send");

/**
 * Path function references.
 * @private
 */

let extname = path.extname;
let join = path.join;
let normalize = path.normalize;
let resolve = path.resolve;
let sep = path.sep;

/**
 * Regular expression for identifying a bytes Range header.
 * @private
 */

let BYTES_RANGE_REGEXP = /^ *bytes=/;

/**
 * Maximum value allowed for the max age.
 * @private
 */

let MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000; // 1 year

/**
 * Regular expression to match a path with a directory up component.
 * @private
 */

let UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Module exports.
 * @public
 */

module.exports = send;
module.exports.mime = mime;

/**
 * Return a `SendStream` for `req` and `path`.
 *
 * @param {object} req
 * @param {string} path
 * @param {object} [options]
 * @return {SendStream}
 * @public
 */

function send(req, path, options) {
  return new SendStream(req, path, options);
}

/**
 * Initialize a `SendStream` with the given `path`.
 *
 * @param {Request} req
 * @param {String} path
 * @param {object} [options]
 * @private
 */

class SendStream {
  constructor(req, path, options) {
    Stream.call(this);

    let opts = options || {};

    this.options = opts;
    this.path = path;
    this.req = req;

    this._acceptRanges = opts.acceptRanges !== undefined
      ? Boolean(opts.acceptRanges)
      : true;

    this._cacheControl = opts.cacheControl !== undefined
      ? Boolean(opts.cacheControl)
      : true;

    this._etag = opts.etag !== undefined
      ? Boolean(opts.etag)
      : true;

    this._dotfiles = opts.dotfiles !== undefined
      ? opts.dotfiles
      : 'ignore';

    if (this._dotfiles !== 'ignore' && this._dotfiles !== 'allow' && this._dotfiles !== 'deny') {
      throw new TypeError('dotfiles option must be "allow", "deny", or "ignore"');
    }

    this._hidden = Boolean(opts.hidden);

    if (opts.hidden !== undefined) {
      deprecate('hidden: use dotfiles: \'' + (this._hidden ? 'allow' : 'ignore') + '\' instead');
    }

    // legacy support
    if (opts.dotfiles === undefined) {
      this._dotfiles = undefined;
    }

    this._extensions = opts.extensions !== undefined
      ? normalizeList(opts.extensions, 'extensions option')
      : [];

    this._immutable = opts.immutable !== undefined
      ? Boolean(opts.immutable)
      : false;

    this._index = opts.index !== undefined
      ? normalizeList(opts.index, 'index option')
      : ['index.html'];

    this._lastModified = opts.lastModified !== undefined
      ? Boolean(opts.lastModified)
      : true;

    this._maxage = opts.maxAge || opts.maxage;
    this._maxage = typeof this._maxage === 'string'
      ? ms(this._maxage)
      : Number(this._maxage);
    this._maxage = !isNaN(this._maxage)
      ? Math.min(Math.max(0, this._maxage), MAX_MAXAGE)
      : 0;

    this._root = opts.root
      ? resolve(opts.root)
      : null;

    if (!this._root && opts.from) {
      this.from(opts.from);
    }
  }
  /**
   * Set root `path`.
   *
   * @param {String} path
   * @return {SendStream}
   * @api public
   */
  root(path) {
    this._root = resolve(String(path));
    debug('root %s', this._root);
    return this;
  }
  /**
   * Emit error with `status`.
   *
   * @param {number} status
   * @param {Error} [err]
   * @private
   */
  error(status, err) {
    // emit if listeners instead of responding
    if (hasListeners(this, 'error')) {
      return this.emit('error', createHttpError(status, err));
    }

    let res = this.res;
    let msg = statuses.message[status] || String(status);
    let doc = createHtmlDocument('Error', escapeHtml(msg));

    // clear existing headers
    clearHeaders(res);

    // add error headers
    if (err && err.headers) {
      setHeaders(res, err.headers);
    }

    // send basic response
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Content-Length', Buffer.byteLength(doc));
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(doc);
  }
  /**
   * Check if the pathname ends with "/".
   *
   * @return {boolean}
   * @private
   */
  hasTrailingSlash() {
    return this.path[this.path.length - 1] === '/';
  }
  /**
   * Check if this is a conditional GET request.
   *
   * @return {Boolean}
   * @api private
   */
  isConditionalGET() {
    return this.req.headers['if-match'] ||
      this.req.headers['if-unmodified-since'] ||
      this.req.headers['if-none-match'] ||
      this.req.headers['if-modified-since'];
  }
  /**
   * Check if the request preconditions failed.
   *
   * @return {boolean}
   * @private
   */
  isPreconditionFailure() {
    let req = this.req;
    let res = this.res;

    // if-match
    let match = req.headers['if-match'];
    if (match) {
      let etag = res.getHeader('ETag');
      return !etag || (match !== '*' && parseTokenList(match).every(function (match) {
        return match !== etag && match !== 'W/' + etag && 'W/' + match !== etag;
      }));
    }

    // if-unmodified-since
    let unmodifiedSince = parseHttpDate(req.headers['if-unmodified-since']);
    if (!isNaN(unmodifiedSince)) {
      let lastModified = parseHttpDate(res.getHeader('Last-Modified'));
      return isNaN(lastModified) || lastModified > unmodifiedSince;
    }

    return false;
  }
  /**
   * Strip various content header fields for a change in entity.
   *
   * @private
   */
  removeContentHeaderFields() {
    let res = this.res;

    res.removeHeader('Content-Encoding');
    res.removeHeader('Content-Language');
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Range');
    res.removeHeader('Content-Type');
  }
  /**
   * Respond with 304 not modified.
   *
   * @api private
   */
  notModified() {
    let res = this.res;
    debug('not modified');
    this.removeContentHeaderFields();
    res.statusCode = 304;
    res.end();
  }
  /**
   * Raise error that headers already sent.
   *
   * @api private
   */
  headersAlreadySent() {
    let err = new Error('Can\'t set headers after they are sent.');
    debug('headers already sent');
    this.error(500, err);
  }
  /**
   * Check if the request is cacheable, aka
   * responded with 2xx or 304 (see RFC 2616 section 14.2{5,6}).
   *
   * @return {Boolean}
   * @api private
   */
  isCachable() {
    let statusCode = this.res.statusCode;
    return (statusCode >= 200 && statusCode < 300) ||
      statusCode === 304;
  }
  /**
   * Handle stat() error.
   *
   * @param {Error} error
   * @private
   */
  onStatError(error) {
    switch (error.code) {
      case 'ENAMETOOLONG':
      case 'ENOENT':
      case 'ENOTDIR':
        this.error(404, error);
        break;
      default:
        this.error(500, error);
        break;
    }
  }
  /**
   * Check if the cache is fresh.
   *
   * @return {Boolean}
   * @api private
   */
  isFresh() {
    return fresh(this.req.headers, {
      etag: this.res.getHeader('ETag'),
      'last-modified': this.res.getHeader('Last-Modified')
    });
  }
  /**
   * Check if the range is fresh.
   *
   * @return {Boolean}
   * @api private
   */
  isRangeFresh() {
    let ifRange = this.req.headers['if-range'];

    if (!ifRange) {
      return true;
    }

    // if-range as etag
    if (ifRange.indexOf('"') !== -1) {
      let etag = this.res.getHeader('ETag');
      return Boolean(etag && ifRange.indexOf(etag) !== -1);
    }

    // if-range as modified date
    let lastModified = this.res.getHeader('Last-Modified');
    return parseHttpDate(lastModified) <= parseHttpDate(ifRange);
  }
  /**
   * Redirect to path.
   *
   * @param {string} path
   * @private
   */
  redirect(path) {
    let res = this.res;

    if (hasListeners(this, 'directory')) {
      this.emit('directory', res, path);
      return;
    }

    if (this.hasTrailingSlash()) {
      this.error(403);
      return;
    }

    let loc = encodeUrl(collapseLeadingSlashes(this.path + '/'));
    let doc = createHtmlDocument('Redirecting', 'Redirecting to <a href="' + escapeHtml(loc) + '">' +
      escapeHtml(loc) + '</a>');

    // redirect
    res.statusCode = 301;
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Content-Length', Buffer.byteLength(doc));
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Location', loc);
    res.end(doc);
  }
  /**
   * Pipe to `res.
   *
   * @param {Stream} res
   * @return {Stream} res
   * @api public
   */
  pipe(res) {
    // root path
    let root = this._root;

    // references
    this.res = res;

    // decode the path
    let path = decode(this.path);
    if (path === -1) {
      this.error(400);
      return res;
    }

    // null byte(s)
    if (~path.indexOf('\0')) {
      this.error(400);
      return res;
    }

    let parts;
    if (root !== null) {
      // normalize
      if (path) {
        path = normalize('.' + sep + path);
      }

      // malicious path
      if (UP_PATH_REGEXP.test(path)) {
        debug('malicious path "%s"', path);
        this.error(403);
        return res;
      }

      // explode path parts
      parts = path.split(sep);

      // join / normalize from optional root dir
      path = normalize(join(root, path));
    } else {
      // ".." is malicious without "root"
      if (UP_PATH_REGEXP.test(path)) {
        debug('malicious path "%s"', path);
        this.error(403);
        return res;
      }

      // explode path parts
      parts = normalize(path).split(sep);

      // resolve the path
      path = resolve(path);
    }

    // dotfile handling
    if (containsDotFile(parts)) {
      let access = this._dotfiles;

      // legacy support
      if (access === undefined) {
        access = parts[parts.length - 1][0] === '.'
          ? (this._hidden ? 'allow' : 'ignore')
          : 'allow';
      }

      debug('%s dotfile "%s"', access, path);
      switch (access) {
        case 'allow':
          break;
        case 'deny':
          this.error(403);
          return res;
        case 'ignore':
        default:
          this.error(404);
          return res;
      }
    }

    // index file support
    if (this._index.length && this.hasTrailingSlash()) {
      this.sendIndex(path);
      return res;
    }

    this.sendFile(path);
    return res;
  }
  /**
   * Transfer `path`.
   *
   * @param {String} path
   * @api public
   */
  send(path, stat) {
    let len = stat.size;
    let options = this.options;
    let opts = {};
    let res = this.res;
    let req = this.req;
    let ranges = req.headers.range;
    let offset = options.start || 0;

    if (headersSent(res)) {
      // impossible to send now
      this.headersAlreadySent();
      return;
    }

    debug('pipe "%s"', path);

    // set header fields
    this.setHeader(path, stat);

    // set content-type
    this.type(path);

    // conditional GET support
    if (this.isConditionalGET()) {
      if (this.isPreconditionFailure()) {
        this.error(412);
        return;
      }

      if (this.isCachable() && this.isFresh()) {
        this.notModified();
        return;
      }
    }

    // adjust len to start/end options
    len = Math.max(0, len - offset);
    if (options.end !== undefined) {
      let bytes = options.end - offset + 1;
      if (len > bytes) len = bytes;
    }

    // Range support
    if (this._acceptRanges && BYTES_RANGE_REGEXP.test(ranges)) {
      // parse
      ranges = parseRange(len, ranges, {
        combine: true
      });

      // If-Range support
      if (!this.isRangeFresh()) {
        debug('range stale');
        ranges = -2;
      }

      // unsatisfiable
      if (ranges === -1) {
        debug('range unsatisfiable');

        // Content-Range
        res.setHeader('Content-Range', contentRange('bytes', len));

        // 416 Requested Range Not Satisfiable
        return this.error(416, {
          headers: { 'Content-Range': res.getHeader('Content-Range') }
        });
      }

      // valid (syntactically invalid/multiple ranges are treated as a regular response)
      if (ranges !== -2 && ranges.length === 1) {
        debug('range %j', ranges);

        // Content-Range
        res.statusCode = 206;
        res.setHeader('Content-Range', contentRange('bytes', len, ranges[0]));

        // adjust for requested range
        offset += ranges[0].start;
        len = ranges[0].end - ranges[0].start + 1;
      }
    }

    // clone options
    for (let prop in options) {
      opts[prop] = options[prop];
    }

    // set read options
    opts.start = offset;
    opts.end = Math.max(offset, offset + len - 1);

    // content-length
    res.setHeader('Content-Length', len);

    // HEAD support
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    this.stream(path, opts);
  }
  /**
   * Transfer file for `path`.
   *
   * @param {String} path
   * @api private
   */
  sendFile(path) {
    let i = 0;
    let self = this;

    debug('stat "%s"', path);
    fs.stat(path, function onstat(err, stat) {
      if (err && err.code === 'ENOENT' && !extname(path) && path[path.length - 1] !== sep) {
        // not found, check extensions
        return next(err);
      }
      if (err) return self.onStatError(err);
      if (stat.isDirectory()) return self.redirect(path);
      self.emit('file', path, stat);
      self.send(path, stat);
    });

    function next(err) {
      if (self._extensions.length <= i) {
        return err
          ? self.onStatError(err)
          : self.error(404);
      }

      let p = path + '.' + self._extensions[i++];

      debug('stat "%s"', p);
      fs.stat(p, function (err, stat) {
        if (err) return next(err);
        if (stat.isDirectory()) return next();
        self.emit('file', p, stat);
        self.send(p, stat);
      });
    }
  }
  /**
   * Transfer index for `path`.
   *
   * @param {String} path
   * @api private
   */
  sendIndex(path) {
    let i = -1;
    let self = this;

    function next(err) {
      if (++i >= self._index.length) {
        if (err) return self.onStatError(err);
        return self.error(404);
      }

      let p = join(path, self._index[i]);

      debug('stat "%s"', p);
      fs.stat(p, function (err, stat) {
        if (err) return next(err);
        if (stat.isDirectory()) return next();
        self.emit('file', p, stat);
        self.send(p, stat);
      });
    }

    next();
  }
  /**
   * Stream `path` to the response.
   *
   * @param {String} path
   * @param {Object} options
   * @api private
   */
  stream(path, options) {
    let self = this;
    let res = this.res;

    // pipe
    let stream = fs.createReadStream(path, options);
    this.emit('stream', stream);
    stream.pipe(res);

    // cleanup
    function cleanup() {
      destroy(stream, true);
    }

    // response finished, cleanup
    onFinished(res, cleanup);

    // error handling
    stream.on('error', function onerror(err) {
      // clean up stream early
      cleanup();

      // error
      self.onStatError(err);
    });

    // end
    stream.on('end', function onend() {
      self.emit('end');
    });
  }
  /**
   * Set content-type based on `path`
   * if it hasn't been explicitly set.
   *
   * @param {String} path
   * @api private
   */
  type(path) {
    let res = this.res;

    if (res.getHeader('Content-Type')) return;

    let type = mime.lookup(path);

    if (!type) {
      debug('no content-type');
      return;
    }

    let charset = mime.charsets.lookup(type);

    debug('content-type %s', type);
    res.setHeader('Content-Type', type + (charset ? '; charset=' + charset : ''));
  }
  /**
   * Set response header fields, most
   * fields may be pre-defined.
   *
   * @param {String} path
   * @param {Object} stat
   * @api private
   */
  setHeader(path, stat) {
    let res = this.res;

    this.emit('headers', res, path, stat);

    if (this._acceptRanges && !res.getHeader('Accept-Ranges')) {
      debug('accept ranges');
      res.setHeader('Accept-Ranges', 'bytes');
    }

    if (this._cacheControl && !res.getHeader('Cache-Control')) {
      let cacheControl = 'public, max-age=' + Math.floor(this._maxage / 1000);

      if (this._immutable) {
        cacheControl += ', immutable';
      }

      debug('cache-control %s', cacheControl);
      res.setHeader('Cache-Control', cacheControl);
    }

    if (this._lastModified && !res.getHeader('Last-Modified')) {
      let modified = stat.mtime.toUTCString();
      debug('modified %s', modified);
      res.setHeader('Last-Modified', modified);
    }

    if (this._etag && !res.getHeader('ETag')) {
      let val = etag(stat);
      debug('etag %s', val);
      res.setHeader('ETag', val);
    }
  }
}

/**
 * Inherits from `Stream`.
 */

util.inherits(SendStream, Stream);

/**
 * Enable or disable etag generation.
 *
 * @param {Boolean} val
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.etag = deprecate.function(function etag(val) {
  this._etag = Boolean(val);
  debug('etag %s', this._etag);
  return this;
}, 'send.etag: pass etag as option');

/**
 * Enable or disable "hidden" (dot) files.
 *
 * @param {Boolean} path
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.hidden = deprecate.function(function hidden(val) {
  this._hidden = Boolean(val);
  this._dotfiles = undefined;
  debug('hidden %s', this._hidden);
  return this;
}, 'send.hidden: use dotfiles option');

/**
 * Set index `paths`, set to a falsy
 * value to disable index support.
 *
 * @param {String|Boolean|Array} paths
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.index = deprecate.function(function index(paths) {
  let index = !paths ? [] : normalizeList(paths, 'paths argument');
  debug('index %o', paths);
  this._index = index;
  return this;
}, 'send.index: pass index as option');


SendStream.prototype.from = deprecate.function(SendStream.prototype.root,
  'send.from: pass root as option');

SendStream.prototype.root = deprecate.function(SendStream.prototype.root,
  'send.root: pass root as option');

/**
 * Set max-age to `maxAge`.
 *
 * @param {Number} maxAge
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.maxage = deprecate.function(function maxage(maxAge) {
  this._maxage = typeof maxAge === 'string'
    ? ms(maxAge)
    : Number(maxAge);
  this._maxage = !isNaN(this._maxage)
    ? Math.min(Math.max(0, this._maxage), MAX_MAXAGE)
    : 0;
  debug('max-age %d', this._maxage);
  return this;
}, 'send.maxage: pass maxAge as option');




















/**
 * Clear all headers from a response.
 *
 * @param {object} res
 * @private
 */

function clearHeaders(res) {
  let headers = getHeaderNames(res);

  for (let i = 0; i < headers.length; i++) {
    res.removeHeader(headers[i]);
  }
}

/**
 * Collapse all leading slashes into a single slash
 *
 * @param {string} str
 * @private
 */
function collapseLeadingSlashes(str) {
  let i = 0;

  for (; i < str.length; i++) {
    if (str[i] !== '/') {
      break;
    }
  }

  return i > 1
    ? '/' + str.slice(i)
    : str;
}

/**
 * Determine if path parts contain a dotfile.
 *
 * @api private
 */

function containsDotFile(parts) {
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    if (part.length > 1 && part[0] === '.') {
      return true;
    }
  }

  return false;
}

/**
 * Create a Content-Range header.
 *
 * @param {string} type
 * @param {number} size
 * @param {array} [range]
 */

function contentRange(type, size, range) {
  return type + ' ' + (range ? range.start + '-' + range.end : '*') + '/' + size;
}

/**
 * Create a minimal HTML document.
 *
 * @param {string} title
 * @param {string} body
 * @private
 */

function createHtmlDocument(title, body) {
  return '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<title>' + title + '</title>\n' +
    '</head>\n' +
    '<body>\n' +
    '<pre>' + body + '</pre>\n' +
    '</body>\n' +
    '</html>\n';
}

/**
 * Create a HttpError object from simple arguments.
 *
 * @param {number} status
 * @param {Error|object} err
 * @private
 */

function createHttpError(status, err) {
  if (!err) {
    return createError(status);
  }

  return err instanceof Error
    ? createError(status, err, { expose: false })
    : createError(status, err);
}

/**
 * decodeURIComponent.
 *
 * Allows V8 to only deoptimize this fn instead of all
 * of send().
 *
 * @param {String} path
 * @api private
 */

function decode(path) {
  try {
    return decodeURIComponent(path);
  } catch (err) {
    return -1;
  }
}

/**
 * Get the header names on a respnse.
 *
 * @param {object} res
 * @returns {array[string]}
 * @private
 */

function getHeaderNames(res) {
  return typeof res.getHeaderNames !== 'function'
    ? Object.keys(res._headers || {})
    : res.getHeaderNames();
}

/**
 * Determine if emitter has listeners of a given type.
 *
 * The way to do this check is done three different ways in Node.js >= 0.8
 * so this consolidates them into a minimal set using instance methods.
 *
 * @param {EventEmitter} emitter
 * @param {string} type
 * @returns {boolean}
 * @private
 */

function hasListeners(emitter, type) {
  let count = typeof emitter.listenerCount !== 'function'
    ? emitter.listeners(type).length
    : emitter.listenerCount(type);

  return count > 0;
}

/**
 * Determine if the response headers have been sent.
 *
 * @param {object} res
 * @returns {boolean}
 * @private
 */

function headersSent(res) {
  return typeof res.headersSent !== 'boolean'
    ? Boolean(res._header)
    : res.headersSent;
}

/**
 * Normalize the index option into an array.
 *
 * @param {boolean|string|array} val
 * @param {string} name
 * @private
 */

function normalizeList(val, name) {
  let list = [].concat(val || []);

  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== 'string') {
      throw new TypeError(name + ' must be array of strings or false');
    }
  }

  return list;
}

/**
 * Parse an HTTP Date into a number.
 *
 * @param {string} date
 * @private
 */

function parseHttpDate(date) {
  let timestamp = date && Date.parse(date);

  return typeof timestamp === 'number'
    ? timestamp
    : NaN;
}

/**
 * Parse a HTTP token list.
 *
 * @param {string} str
 * @private
 */

function parseTokenList(str) {
  let end = 0;
  let list = [];
  let start = 0;

  // gather tokens
  for (let i = 0, len = str.length; i < len; i++) {
    switch (str.charCodeAt(i)) {
      case 0x20: /*   */
        if (start === end) {
          start = end = i + 1;
        }
        break;
      case 0x2c: /* , */
        if (start !== end) {
          list.push(str.substring(start, end));
        }
        start = end = i + 1;
        break;
      default:
        end = i + 1;
        break;
    }
  }

  // final token
  if (start !== end) {
    list.push(str.substring(start, end));
  }

  return list;
}

/**
 * Set an object of headers on a response.
 *
 * @param {object} res
 * @param {object} headers
 * @private
 */

function setHeaders(res, headers) {
  let keys = Object.keys(headers);

  for (let i = 0; i < keys.length; i++) {
    let key = keys[i];
    res.setHeader(key, headers[key]);
  }
}
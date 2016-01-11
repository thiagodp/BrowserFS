import file_system = require('../core/file_system');
import {ApiError, ErrorCode} from '../core/api_error';
import {FileFlag, ActionType} from '../core/file_flag';
import {copyingSlice} from '../core/util';
import file = require('../core/file');
import Stats from '../core/node_fs_stats';
import preload_file = require('../generic/preload_file');
import xhr = require('../generic/xhr');
import {FileIndex, DirInode, FileInode, Inode, isFileInode, isDirInode} from '../generic/file_index';

/**
 * Try to convert the given buffer into a string, and pass it to the callback.
 * Optimization that removes the needed try/catch into a helper function, as
 * this is an uncommon case.
 */
function tryToString(buff: Buffer, encoding: string, cb: (e: ApiError, rv?: string) => void) {
  try {
    cb(null, buff.toString(encoding));
  } catch (e) {
    cb(e);
  }
}

/**
 * A simple filesystem backed by XmlHttpRequests.
 */
export default class XmlHttpRequest extends file_system.BaseFileSystem implements file_system.FileSystem {
  private _index: FileIndex<{}>;
  public prefixUrl: string;
  /**
   * Constructs the file system.
   * @param listingUrlOrObj index object or the path to the JSON file index generated by
   *   tools/XHRIndexer.coffee. This can be relative to the current webpage URL
   *   or absolutely specified.
   * @param prefixUrl The url prefix to use for all web-server requests.
   */
  constructor(listingUrlOrObj: string | Object, prefixUrl: string = '') {
    super();
    if (listingUrlOrObj == null) {
      listingUrlOrObj = 'index.json';
    }
    // prefix_url must end in a directory separator.
    if (prefixUrl.length > 0 && prefixUrl.charAt(prefixUrl.length - 1) !== '/') {
      prefixUrl = prefixUrl + '/';
    }
    this.prefixUrl = prefixUrl;

    let listing:Object = null;
    if (typeof listingUrlOrObj == "string") {
      listing = this._requestFileSync(<string> listingUrlOrObj, 'json');
      if (listing == null) {
        throw new Error("Unable to find listing at URL: " + listingUrlOrObj);
      }
    } else {
      listing = listingUrlOrObj;
    }

    this._index = FileIndex.fromListing(listing);
  }

  public empty(): void {
    this._index.fileIterator(function(file: Stats) {
      file.file_data = null;
    });
  }

  private getXhrPath(filePath: string): string {
    if (filePath.charAt(0) === '/') {
      filePath = filePath.slice(1);
    }
    return this.prefixUrl + filePath;
  }

  /**
   * Only requests the HEAD content, for the file size.
   */
  public _requestFileSizeAsync(path: string, cb: (err: ApiError, size?: number) => void): void {
    xhr.getFileSizeAsync(this.getXhrPath(path), cb);
  }
  public _requestFileSizeSync(path: string): number {
    return xhr.getFileSizeSync(this.getXhrPath(path));
  }

  /**
   * Asynchronously download the given file.
   */
  private _requestFileAsync(p: string, type: 'buffer', cb: (err: ApiError, data?: NodeBuffer) => void): void;
  private _requestFileAsync(p: string, type: 'json', cb: (err: ApiError, data?: any) => void): void;
  private _requestFileAsync(p: string, type: string, cb: (err: ApiError, data?: any) => void): void;
  private _requestFileAsync(p: string, type: string, cb: (err: ApiError, data?: any) => void): void {
    xhr.asyncDownloadFile(this.getXhrPath(p), type, cb);
  }

  /**
   * Synchronously download the given file.
   */
  private _requestFileSync(p: string, type: 'buffer'): NodeBuffer;
  private _requestFileSync(p: string, type: 'json'): any;
  private _requestFileSync(p: string, type: string): any;
  private _requestFileSync(p: string, type: string): any {
    return xhr.syncDownloadFile(this.getXhrPath(p), type);
  }

  public getName(): string {
    return 'XmlHttpRequest';
  }

  public static isAvailable(): boolean {
    // @todo Older browsers use a different name for XHR, iirc.
    return typeof XMLHttpRequest !== "undefined" && XMLHttpRequest !== null;
  }

  public diskSpace(path: string, cb: (total: number, free: number) => void): void {
    // Read-only file system. We could calculate the total space, but that's not
    // important right now.
    cb(0, 0);
  }

  public isReadOnly(): boolean {
    return true;
  }

  public supportsLinks(): boolean {
    return false;
  }

  public supportsProps(): boolean {
    return false;
  }

  public supportsSynch(): boolean {
    return true;
  }

  /**
   * Special XHR function: Preload the given file into the index.
   * @param [String] path
   * @param [BrowserFS.Buffer] buffer
   */
  public preloadFile(path: string, buffer: NodeBuffer): void {
    var inode = this._index.getInode(path);
    if (isFileInode<Stats>(inode)) {
      if (inode === null) {
        throw ApiError.ENOENT(path);
      }
      var stats = inode.getData();
      stats.size = buffer.length;
      stats.file_data = buffer;
    } else {
      throw ApiError.EISDIR(path);
    }
  }

  public stat(path: string, isLstat: boolean, cb: (e: ApiError, stat?: Stats) => void): void {
    var inode = this._index.getInode(path);
    if (inode === null) {
      return cb(ApiError.ENOENT(path));
    }
    var stats: Stats;
    if (isFileInode<Stats>(inode)) {
      stats = inode.getData();
      // At this point, a non-opened file will still have default stats from the listing.
      if (stats.size < 0) {
        this._requestFileSizeAsync(path, function(e: ApiError, size?: number) {
          if (e) {
            return cb(e);
          }
          stats.size = size;
          cb(null, stats.clone());
        });
      } else {
        cb(null, stats.clone());
      }
    } else if (isDirInode(inode)) {
      stats = inode.getStats();
      cb(null, stats);
    } else {
      cb(ApiError.FileError(ErrorCode.EINVAL, path));
    }
  }

  public statSync(path: string, isLstat: boolean): Stats {
    var inode = this._index.getInode(path);
    if (inode === null) {
      throw ApiError.ENOENT(path);
    }
    var stats: Stats;
    if (isFileInode<Stats>(inode)) {
      stats = inode.getData();
      // At this point, a non-opened file will still have default stats from the listing.
      if (stats.size < 0) {
        stats.size = this._requestFileSizeSync(path);
      }
    } else if (isDirInode(inode)) {
      stats = inode.getStats();
    } else {
      throw ApiError.FileError(ErrorCode.EINVAL, path);
    }
    return stats;
  }

  public open(path: string, flags: FileFlag, mode: number, cb: (e: ApiError, file?: file.File) => void): void {
    // INVARIANT: You can't write to files on this file system.
    if (flags.isWriteable()) {
      return cb(new ApiError(ErrorCode.EPERM, path));
    }
    var _this = this;
    // Check if the path exists, and is a file.
    var inode = this._index.getInode(path);
    if (inode === null) {
      return cb(ApiError.ENOENT(path));
    }
    if (isFileInode<Stats>(inode)) {
      var stats = inode.getData();
      switch (flags.pathExistsAction()) {
        case ActionType.THROW_EXCEPTION:
        case ActionType.TRUNCATE_FILE:
          return cb(ApiError.EEXIST(path));
        case ActionType.NOP:
          // Use existing file contents.
          // XXX: Uh, this maintains the previously-used flag.
          if (stats.file_data != null) {
            return cb(null, new preload_file.NoSyncFile(_this, path, flags, stats.clone(), stats.file_data));
          }
          // @todo be lazier about actually requesting the file
          this._requestFileAsync(path, 'buffer', function(err: ApiError, buffer?: NodeBuffer) {
            if (err) {
              return cb(err);
            }
            // we don't initially have file sizes
            stats.size = buffer.length;
            stats.file_data = buffer;
            return cb(null, new preload_file.NoSyncFile(_this, path, flags, stats.clone(), buffer));
          });
          break;
        default:
          return cb(new ApiError(ErrorCode.EINVAL, 'Invalid FileMode object.'));
      }
    } else {
      return cb(ApiError.EISDIR(path));
    }
  }

  public openSync(path: string, flags: FileFlag, mode: number): file.File {
    // INVARIANT: You can't write to files on this file system.
    if (flags.isWriteable()) {
      throw new ApiError(ErrorCode.EPERM, path);
    }
    // Check if the path exists, and is a file.
    var inode = this._index.getInode(path);
    if (inode === null) {
      throw ApiError.ENOENT(path);
    }
    if (isFileInode<Stats>(inode)) {
      var stats = inode.getData();
      switch (flags.pathExistsAction()) {
        case ActionType.THROW_EXCEPTION:
        case ActionType.TRUNCATE_FILE:
          throw ApiError.EEXIST(path);
        case ActionType.NOP:
          // Use existing file contents.
          // XXX: Uh, this maintains the previously-used flag.
          if (stats.file_data != null) {
            return new preload_file.NoSyncFile(this, path, flags, stats.clone(), stats.file_data);
          }
          // @todo be lazier about actually requesting the file
          var buffer = this._requestFileSync(path, 'buffer');
          // we don't initially have file sizes
          stats.size = buffer.length;
          stats.file_data = buffer;
          return new preload_file.NoSyncFile(this, path, flags, stats.clone(), buffer);
        default:
          throw new ApiError(ErrorCode.EINVAL, 'Invalid FileMode object.');
      }
    } else {
      throw ApiError.EISDIR(path);
    }
  }

  public readdir(path: string, cb: (e: ApiError, listing?: string[]) => void): void {
    try {
      cb(null, this.readdirSync(path));
    } catch (e) {
      cb(e);
    }
  }

  public readdirSync(path: string): string[] {
    // Check if it exists.
    var inode = this._index.getInode(path);
    if (inode === null) {
      throw ApiError.ENOENT(path);
    } else if (isDirInode(inode)) {
      return inode.getListing();
    } else {
      throw ApiError.ENOTDIR(path);
    }
  }

  /**
   * We have the entire file as a buffer; optimize readFile.
   */
  public readFile(fname: string, encoding: string, flag: FileFlag, cb: (err: ApiError, data?: any) => void): void {
    // Wrap cb in file closing code.
    var oldCb = cb;
    // Get file.
    this.open(fname, flag, 0x1a4, function(err: ApiError, fd?: file.File) {
      if (err) {
        return cb(err);
      }
      cb = function(err: ApiError, arg?: Buffer) {
        fd.close(function(err2: any) {
          if (err == null) {
            err = err2;
          }
          return oldCb(err, arg);
        });
      };
      var fdCast = <preload_file.NoSyncFile<XmlHttpRequest>> fd;
      var fdBuff = <Buffer> fdCast.getBuffer();
      if (encoding === null) {
        cb(err, copyingSlice(fdBuff));
      } else {
        tryToString(fdBuff, encoding, cb);
      }
    });
  }

  /**
   * Specially-optimized readfile.
   */
  public readFileSync(fname: string, encoding: string, flag: FileFlag): any {
    // Get file.
    var fd = this.openSync(fname, flag, 0x1a4);
    try {
      var fdCast = <preload_file.NoSyncFile<XmlHttpRequest>> fd;
      var fdBuff = <Buffer> fdCast.getBuffer();
      if (encoding === null) {
        return copyingSlice(fdBuff);
      }
      return fdBuff.toString(encoding);
    } finally {
      fd.closeSync();
    }
  }
}

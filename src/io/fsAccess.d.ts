/**
 * File System Access API surface used by io/localFolder.ts that TypeScript's
 * lib.dom doesn't declare (the picker, permissions, and async iteration are
 * WICG extensions beyond the WHATWG File System standard). Global-scope
 * augmentations — keep this file free of imports/exports.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
}

interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }): Promise<FileSystemDirectoryHandle>;
}

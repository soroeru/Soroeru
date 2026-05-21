export {};

declare global {
  const chrome: {
    runtime: {
      onInstalled: {
        addListener(listener: () => void): void;
      };
    };
    storage: {
      local: ChromeStorageArea;
    };
  };

  interface ChromeStorageArea {
    get(
      keys: string | string[] | Record<string, unknown> | null,
      callback: (items: Record<string, unknown>) => void,
    ): void;
    set(items: Record<string, unknown>, callback?: () => void): void;
    remove(keys: string | string[], callback?: () => void): void;
    clear(callback?: () => void): void;
  }
}

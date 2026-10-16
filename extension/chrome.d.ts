declare namespace chrome {
  namespace action {
    function setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
  }

  namespace permissions {
    function contains(details: { origins?: string[] }): Promise<boolean>;
    function request(details: { origins?: string[] }): Promise<boolean>;
    function remove(details: { origins?: string[] }): Promise<boolean>;
    function getAll(): Promise<{ origins?: string[] }>;
    const onRemoved: {
      addListener(listener: (permissions: { origins?: string[] }) => void): void;
    };
  }

  namespace storage {
    const local: {
      set(items: Record<string, unknown>): Promise<void>;
    };
    const session: {
      set(items: Record<string, unknown>): Promise<void>;
      get(keys: string | string[]): Promise<Record<string, unknown>>;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
      status?: "loading" | "complete";
    }
    function get(tabId: number): Promise<Tab>;
    function create(createProperties: { url: string; active?: boolean }): Promise<Tab>;
    function update(tabId: number, updateProperties: { url: string }): Promise<Tab>;
    function sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<tabs.Tab[]>;
    const onRemoved: {
      addListener(listener: (tabId: number) => void): void;
      removeListener(listener: (tabId: number) => void): void;
    };
    const onUpdated: {
      addListener(
        listener: (tabId: number, changeInfo: { status?: string; url?: string }, tab: Tab) => void,
      ): void;
      removeListener(
        listener: (tabId: number, changeInfo: { status?: string; url?: string }, tab: Tab) => void,
      ): void;
    };
  }

  namespace scripting {
    function executeScript(details: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  }

  namespace runtime {
    interface MessageSender {
      id?: string;
      url?: string;
      tab?: unknown;
    }
    interface Port {
      name: string;
      sender?: MessageSender;
      disconnect(): void;
      onMessage: { addListener(listener: (message: unknown) => void): void };
      onDisconnect: { addListener(listener: () => void): void };
      postMessage(message: unknown): void;
    }
    const id: string;
    function getURL(path: string): string;
    const onConnect: { addListener(listener: (port: Port) => void): void };
    function connectNative(name: string): Port;
    function connect(connectInfo: { name: string }): Port;
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: { id?: string; tab?: unknown },
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  }
}

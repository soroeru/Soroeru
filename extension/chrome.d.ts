declare namespace chrome {
  namespace action {
    function setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
  }

  namespace permissions {
    function contains(details: { origins?: string[] }): Promise<boolean>;
    function request(details: { origins?: string[] }): Promise<boolean>;
  }

  namespace storage {
    const local: {
      set(items: Record<string, unknown>): Promise<void>;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      status?: "loading" | "complete";
    }
    function get(tabId: number): Promise<Tab>;
    function update(tabId: number, updateProperties: { url: string }): Promise<Tab>;
    function sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<tabs.Tab[]>;
    const onRemoved: {
      addListener(listener: (tabId: number) => void): void;
      removeListener(listener: (tabId: number) => void): void;
    };
    const onUpdated: {
      addListener(listener: (tabId: number, changeInfo: { status?: string }, tab: Tab) => void): void;
      removeListener(listener: (tabId: number, changeInfo: { status?: string }, tab: Tab) => void): void;
    };
  }

  namespace scripting {
    function executeScript(details: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  }

  namespace runtime {
    interface Port {
      onMessage: { addListener(listener: (message: unknown) => void): void };
      onDisconnect: { addListener(listener: () => void): void };
      postMessage(message: unknown): void;
    }
    function connectNative(name: string): Port;
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(
        listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void,
      ): void;
    };
  }
}

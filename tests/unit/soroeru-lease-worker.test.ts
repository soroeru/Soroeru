import assert from "node:assert/strict";
import { test } from "node:test";
import { LeaseClient, type PortLike } from "../../extension/panel/lease-client.js";
import { startLeaseWorker } from "../../extension/worker.js";
import {
  EXTENSION_MESSAGE_VERSION as version,
  PANEL_PORT_NAME,
  type ExtensionMessage,
} from "../../src/shared/extension-messages.js";

function event<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (listener: (...args: Args) => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: (...args: Args) => void) => {
      listeners.delete(listener);
    },
    emit: (...args: Args) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const connect = event<[chrome.runtime.Port]>();
  const updated = event<[number, { status?: string; url?: string }, chrome.tabs.Tab]>();
  const removed = event<[number]>();
  const input = event<[unknown]>();
  const disconnect = event<[]>();
  const output = event<[ExtensionMessage]>();
  const messages: ExtensionMessage[] = [];
  const contentMessages: ExtensionMessage[] = [];
  const revocations = event<[]>();
  let url = "https://example.test/account";
  let status = "complete";
  const loadingRead = deferred<void>();
  const workerInputs: unknown[] = [];
  input.addListener((message) => {
    workerInputs.push(message);
  });
  let permission: () => Promise<boolean> = async () => true;
  let bind: () => Promise<{ ok: boolean }> = async () => ({ ok: true });
  const port = {
    name: PANEL_PORT_NAME,
    sender: { id: "fake-extension", url: "chrome-extension://fake-extension/sidepanel.html" },
    onMessage: input,
    onDisconnect: disconnect,
    postMessage: (message: ExtensionMessage) => {
      messages.push(message);
      output.emit(message);
    },
    disconnect: () => disconnect.emit(),
  } as unknown as chrome.runtime.Port;
  const tab = () => ({ id: 7, url, status }) as chrome.tabs.Tab;
  const api = {
    runtime: {
      id: "fake-extension",
      getURL: (path: string) => `chrome-extension://fake-extension/${path}`,
      onConnect: connect,
      onMessage: event<[]>(),
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    action: { setBadgeText: async () => {} },
    scripting: { executeScript: async () => [] },
    permissions: { contains: () => permission(), onRemoved: event<[{ origins?: string[] }]>() },
    tabs: {
      get: async () => {
        if (status === "loading") loadingRead.resolve();
        return tab();
      },
      onUpdated: updated,
      onRemoved: removed,
      update: async (_id: number, options: { url: string }) => {
        url = options.url;
        updated.emit(7, { status: "complete" }, tab());
        return tab();
      },
      sendMessage: async (_id: number, message: ExtensionMessage) => {
        contentMessages.push(message);
        if (message.kind === "lease.revoke") revocations.emit();
        if (message.kind === "lease.bind") return bind();
        return undefined;
      },
    },
  };
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: api });
  const worker = startLeaseWorker();
  connect.emit(port);
  const waitFor = (predicate: (message: ExtensionMessage) => boolean): Promise<ExtensionMessage> => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const listener = (message: ExtensionMessage) => {
        if (predicate(message)) {
          output.removeListener(listener);
          resolve(message);
        }
      };
      output.addListener(listener);
    });
  };
  return {
    ...worker,
    messages,
    contentMessages,
    input,
    disconnect,
    waitFor,
    workerInputs,
    loadingRead: loadingRead.promise,
    beginNavigation: () => {
      status = "loading";
    },
    completeNavigation: () => {
      status = "complete";
      url = "https://example.test/profile";
      updated.emit(7, { status: "complete" }, tab());
    },
    clientPort: () =>
      ({
        postMessage: (message: unknown) => input.emit(message),
        disconnect: () => disconnect.emit(),
        onMessage: output,
        onDisconnect: disconnect,
      }) as PortLike,
    revokedTwice: () =>
      new Promise<void>((resolve) => {
        const listener = () => {
          if (contentMessages.filter((message) => message.kind === "lease.revoke").length >= 2) {
            revocations.removeListener(listener);
            resolve();
          }
        };
        revocations.addListener(listener);
        listener();
      }),
    setPermission: (handler: typeof permission) => {
      permission = handler;
    },
    setBind: (handler: typeof bind) => {
      bind = handler;
    },
    open: () =>
      input.emit({
        version,
        kind: "lease.open",
        nonce: "fake-nonce",
        tabId: 7,
        origin: "https://example.test",
      }),
    restore: () => {
      disconnect.emit();
      if (previous) Object.defineProperty(globalThis, "chrome", previous);
      else Reflect.deleteProperty(globalThis, "chrome");
    },
  };
}

test("worker goto accepts its navigation epoch and rejects the old epoch afterward", async () => {
  const fake = fixture();
  try {
    fake.open();
    const opened = await fake.waitFor((message) => message.kind === "lease.opened");
    assert.equal(opened.kind, "lease.opened");
    if (opened.kind !== "lease.opened") throw new Error("missing lease");
    fake.input.emit({
      version,
      kind: "page.command",
      requestId: "goto",
      leaseId: opened.leaseId,
      epoch: opened.epoch,
      command: { command: "goto", url: "https://example.test/profile" },
    });
    const result = await fake.waitFor(
      (message) => message.kind === "page.result" && message.requestId === "goto",
    );
    assert.equal(result.kind === "page.result" && result.ok, true);
    assert.equal(fake.registry.get(opened.leaseId)?.epoch, opened.epoch + 1);
    fake.input.emit({
      version,
      kind: "page.command",
      requestId: "stale",
      leaseId: opened.leaseId,
      epoch: opened.epoch,
      command: { command: "currentUrl" },
    });
    const rejected = await fake.waitFor(
      (message) => message.kind === "page.rejected" && message.requestId === "stale",
    );
    assert.equal(rejected.kind === "page.rejected" && rejected.reason, "stale-epoch");
  } finally {
    fake.restore();
  }
});

test("disconnect while host permission is pending cannot create an orphan lease", async () => {
  const fake = fixture();
  const entered = deferred<void>();
  const permission = deferred<boolean>();
  try {
    fake.setPermission(() => {
      entered.resolve();
      return permission.promise;
    });
    fake.open();
    await entered.promise;
    fake.disconnect.emit();
    permission.resolve(true);
    // Drain the permission continuation before asserting absence of a lease/bind.
    await permission.promise;
    assert.equal(fake.registry.list().length, 0);
    assert.equal(
      fake.contentMessages.some((message) => message.kind === "lease.bind"),
      false,
    );
    assert.equal(
      fake.messages.some((message) => message.kind === "lease.opened"),
      false,
    );
  } finally {
    permission.resolve(true);
    fake.restore();
  }
});

test("disconnect during content binding revokes the late binding again", async () => {
  const fake = fixture();
  const entered = deferred<void>();
  const binding = deferred<{ ok: boolean }>();
  try {
    fake.setBind(() => {
      entered.resolve();
      return binding.promise;
    });
    fake.open();
    await entered.promise;
    fake.disconnect.emit();
    binding.resolve({ ok: true });
    // Both the normal disconnect and late-bind cleanup must reach the content script.
    await fake.revokedTwice();
    assert.equal(fake.contentMessages.filter((message) => message.kind === "lease.revoke").length, 2);
    assert.equal(fake.registry.list().length, 0);
    assert.equal(
      fake.messages.some((message) => message.kind === "lease.opened"),
      false,
    );
  } finally {
    binding.resolve({ ok: true });
    fake.restore();
  }
});

test("disconnect during navigation rebind revokes its late binding", async () => {
  const fake = fixture();
  const entered = deferred<void>();
  const binding = deferred<{ ok: boolean }>();
  try {
    fake.open();
    await fake.waitFor((message) => message.kind === "lease.opened");
    fake.setBind(() => {
      entered.resolve();
      return binding.promise;
    });
    fake.completeNavigation();
    await entered.promise;
    fake.disconnect.emit();
    binding.resolve({ ok: true });
    await fake.revokedTwice();
    assert.equal(fake.registry.list().length, 0);
  } finally {
    binding.resolve({ ok: true });
    fake.restore();
  }
});

test("panel click readiness waits for the new document binding and sends values directly", async () => {
  const fake = fixture();
  const entered = deferred<void>();
  const binding = deferred<{ ok: boolean }>();
  const direct: ExtensionMessage[] = [];
  const client = new LeaseClient({
    connectPort: fake.clientPort,
    sendToTab: async (_tabId, message) => {
      direct.push(message);
      if (message.kind !== "page.command") throw new Error("unexpected direct message");
      if (message.command.command === "click") fake.beginNavigation();
      return {
        version,
        kind: "page.result",
        requestId: message.requestId,
        ok: true,
        payload: message.command.command === "readValues" ? { email: "fake@example.test" } : undefined,
      };
    },
  });
  try {
    const lease = await client.openLease({ tabId: 7, origin: "https://example.test" });
    await client.sendPageCommand({ command: "fillField", fieldId: "password", value: "fake-secret" });
    assert.deepEqual(await client.sendPageCommand({ command: "readValues" }), { email: "fake@example.test" });
    await client.sendPageCommand({ command: "click", selector: "button" });
    let ready = false;
    const readiness = client.sendPageCommand({ command: "waitForReady" }).then(() => {
      ready = true;
    });
    await fake.loadingRead;
    fake.setBind(() => {
      entered.resolve();
      return binding.promise;
    });
    fake.completeNavigation();
    await entered.promise;
    assert.equal(ready, false);
    binding.resolve({ ok: true });
    await readiness;
    assert.equal(client.currentLease()?.epoch, lease.epoch + 1);
    assert.ok(
      direct.some(
        (message) =>
          message.kind === "page.command" &&
          message.command.command === "waitForReady" &&
          message.epoch === lease.epoch + 1,
      ),
    );
    const routed = JSON.stringify(fake.workerInputs);
    assert.equal(routed.includes("fake-secret"), false);
    assert.equal(routed.includes("readValues"), false);
    assert.equal(routed.includes("fillField"), false);
    assert.equal(
      fake.contentMessages.some((message) => message.kind === "page.command"),
      false,
    );
  } finally {
    binding.resolve({ ok: true });
    client.close();
    fake.restore();
  }
});

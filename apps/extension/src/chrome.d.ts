/**
 * The slice of the extension API this extension uses. Declared here rather
 * than pulling in @types/chrome, so the package builds offline with nothing
 * but what the monorepo already has.
 */

declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      readonly tab?: { readonly id?: number; readonly url?: string };
    }
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    const onInstalled: { addListener(callback: () => void): void };
  }

  namespace storage {
    namespace local {
      function get(keys: string | string[]): Promise<Record<string, unknown>>;
      function set(items: Record<string, unknown>): Promise<void>;
    }
  }

  namespace tabs {
    function create(properties: { url: string }): Promise<unknown>;
  }
}

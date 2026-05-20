import { AsyncLocalStorage } from "node:async_hooks";

type RequestContext = {
  phone?: string;
};

const requestContextStore = new AsyncLocalStorage<RequestContext>();

export async function runWithRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return await requestContextStore.run(ctx, fn);
}

export function getRequestContextPhone(): string | undefined {
  const store = requestContextStore.getStore();
  const phone = String(store?.phone || "").trim();
  return phone || undefined;
}

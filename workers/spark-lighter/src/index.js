export { Lighter } from "./lighter.js";

export default {
  async fetch(request, env) {
    // One lighter, shared by every visitor — always the same Durable Object instance.
    const id = env.LIGHTER.idFromName("the-one-lighter");
    const stub = env.LIGHTER.get(id);
    return stub.fetch(request);
  },
};

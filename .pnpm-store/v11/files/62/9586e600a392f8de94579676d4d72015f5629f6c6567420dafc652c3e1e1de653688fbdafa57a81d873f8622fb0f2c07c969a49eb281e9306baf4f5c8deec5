import type { ConnectRouter, ConnectRouterOptions, ContextValues } from "@connectrpc/connect";
import type { FastifyInstance, FastifyRequest } from "fastify";
interface FastifyConnectPluginOptions extends ConnectRouterOptions {
    /**
     * Route definitions. We recommend the following pattern:
     *
     * Create a file `connect.ts` with a default export such as this:
     *
     * ```ts
     * import {ConnectRouter} from "@connectrpc/connect";
     *
     * export default (router: ConnectRouter) => {
     *   router.service(ElizaService, {});
     * }
     * ```
     *
     * Then pass this function here.
     */
    routes?: (router: ConnectRouter) => void;
    /**
     * If set, once `fastify.close` is called, waits for the requests to be finished for the specified duration
     * before aborting them.
     */
    shutdownTimeoutMs?: number;
    /**
     * The abort error caused by the shutdown timeout.
     *
     * If this is a ConnectError, it will be sent to the client.
     */
    shutdownError?: unknown;
    /**
     * Context values to extract from the request. These values are passed to
     * the handlers.
     */
    contextValues?: (req: FastifyRequest) => ContextValues;
}
/**
 * Plug your Connect routes into a Fastify server.
 */
export declare function fastifyConnectPlugin(instance: FastifyInstance, opts: FastifyConnectPluginOptions, done: (err?: Error) => void): void;
export {};

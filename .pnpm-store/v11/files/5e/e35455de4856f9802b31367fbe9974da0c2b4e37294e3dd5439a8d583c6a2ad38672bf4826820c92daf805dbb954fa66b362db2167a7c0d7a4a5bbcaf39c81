import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import type { HandlerContext, MethodImplSpec } from "../implementation.js";
import type { AsyncIterableTransform } from "./async-iterable.js";
import type { Interceptor } from "../interceptor.js";
/**
 * Invoke the implementation for a streaming RPC, unless a request gate rejects
 * the call first.
 *
 * The gate runs before the request body is received. If it throws, the returned
 * iterator rejects with its error, so the caller's response pipeline serializes
 * it without reading the body; otherwise the implementation's iterator is
 * returned.
 *
 * @private Internal code, does not follow semantic versioning.
 */
export declare function applyRequestGate<T>(context: HandlerContext, requestGate: ((context: HandlerContext) => void | Promise<void>) | undefined, invoke: () => AsyncIterable<T>): Promise<AsyncIterator<T>>;
/**
 * Invoke a user-provided implementation of a unary RPC. Returns a normalized
 * output message.
 *
 * @private Internal code, does not follow semantic versioning.
 */
export declare function invokeUnaryImplementation<I extends DescMessage, O extends DescMessage>(spec: MethodImplSpec<I, O> & {
    kind: "unary";
}, context: HandlerContext, input: MessageShape<I>, interceptors: Interceptor[]): Promise<MessageShape<O>>;
/**
 * Return an AsyncIterableTransform that invokes a user-provided implementation,
 * giving it input from an asynchronous iterable, and returning its output as an
 * asynchronous iterable.
 *
 * @private Internal code, does not follow semantic versioning.
 */
export declare function transformInvokeImplementation<I extends DescMessage, O extends DescMessage>(spec: MethodImplSpec<I, O>, context: HandlerContext, interceptors: Interceptor[]): AsyncIterableTransform<MessageShape<I>, MessageShape<O>>;

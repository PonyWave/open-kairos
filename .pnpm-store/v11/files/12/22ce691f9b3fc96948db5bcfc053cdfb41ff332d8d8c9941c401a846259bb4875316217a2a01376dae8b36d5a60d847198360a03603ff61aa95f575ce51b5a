// Copyright 2021-2026 The Connect Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import { applyInterceptors } from "../interceptor.js";
import { ConnectError } from "../connect-error.js";
import { createDeadlineSignal, createLinkedAbortController, getAbortSignalReason, } from "./signals.js";
import { normalize, normalizeIterable } from "./normalize.js";
import { Code } from "../code.js";
/**
 * Runs a unary method with the given interceptors. Note that this function
 * is only used when implementing a Transport.
 */
export function runUnaryCall(opt) {
    const next = applyInterceptors(opt.next, opt.interceptors);
    const [signal, abort, done] = setupSignal(opt);
    const req = Object.assign(Object.assign({}, opt.req), { message: normalize(opt.req.method.input, opt.req.message), signal });
    return next(req).then((res) => {
        done();
        return res;
    }, abort);
}
/**
 * Runs a server-streaming method with the given interceptors. Note that this
 * function is only used when implementing a Transport.
 */
export function runStreamingCall(opt) {
    const [signal, abort, done] = setupSignal(opt);
    let doneCalled = false;
    // Resolves once the call ends. This happens when the signal is aborted,
    // regardless of success or failure.
    const aborted = new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
        }
        else {
            signal.addEventListener("abort", () => resolve());
        }
    });
    // Once the call ends, call return on the request iterable so it can clean up
    // any allocated resources.
    void aborted.then(() => {
        var _a, _b;
        const it = opt.req.message[Symbol.asyncIterator]();
        // If the signal is aborted due to an error, we throw the error to the
        // request iterator.
        if (!doneCalled) {
            const error = ConnectError.from(getAbortSignalReason(signal), Code.Canceled);
            (_a = it.throw) === null || _a === void 0 ? void 0 : _a.call(it, error).catch(() => { });
        }
        (_b = it.return) === null || _b === void 0 ? void 0 : _b.call(it).catch(() => { });
    });
    const next = applyInterceptors(async (req) => {
        const res = await opt.next(req);
        const it = res.message[Symbol.asyncIterator]();
        // Once the call ends, call return on the transport iterable so it can
        // clean up any allocated resources.
        void aborted.then(() => { var _a; return (_a = it.return) === null || _a === void 0 ? void 0 : _a.call(it).catch(() => { }); });
        return Object.assign(Object.assign({}, res), { 
            // This stream sits between the interceptors and the transport. Once
            // the call ends, it ends every read with the call's outcome. It races
            // each read against the signal, so it doesn't rely on the transport
            // honoring the signal.
            message: {
                [Symbol.asyncIterator]: () => ({
                    next: async () => {
                        const result = signal.aborted
                            ? undefined
                            : await Promise.race([it.next(), aborted]);
                        if (result !== undefined) {
                            return result;
                        }
                        // The call was aborted, so we end the stream.
                        return doneCalled
                            ? { done: true, value: undefined }
                            : abort(getAbortSignalReason(signal));
                    },
                }),
            } });
    }, opt.interceptors);
    const req = Object.assign(Object.assign({}, opt.req), { message: normalizeIterable(opt.req.method.input, opt.req.message), signal });
    return next(req).then((res) => {
        const it = res.message[Symbol.asyncIterator]();
        // Once the call ends, pull the response stream until it finishes, so each
        // interceptor in the chain sees the outcome and runs its cleanup. We rely
        // on next() rather than passing return() or throw() down the chain, because
        // interceptors may not implement those correctly.
        const drained = aborted.then(async () => {
            try {
                while ((await it.next()).done !== true) { }
            }
            catch (_a) { }
        });
        return Object.assign(Object.assign({}, res), { message: {
                [Symbol.asyncIterator]: () => ({
                    async next() {
                        if (signal.aborted) {
                            await drained;
                            return doneCalled
                                ? { done: true, value: undefined }
                                : abort(getAbortSignalReason(signal));
                        }
                        try {
                            const result = await it.next();
                            if (result.done === true) {
                                doneCalled = true;
                                done();
                            }
                            return result;
                        }
                        catch (e) {
                            return abort(e);
                        }
                    },
                    async return(value) {
                        if (!signal.aborted) {
                            doneCalled = true;
                            done();
                        }
                        await drained;
                        return { done: true, value };
                    },
                    async throw(reason) {
                        if (doneCalled) {
                            throw ConnectError.from(reason);
                        }
                        try {
                            return await abort(reason);
                        }
                        finally {
                            await drained;
                        }
                    },
                }),
            } });
    }, abort);
}
/**
 * Create an AbortSignal for Transport implementations. The signal is available
 * in UnaryRequest and StreamingRequest, and is triggered when the call is
 * aborted (via a timeout or explicit cancellation), errored (e.g. when reading
 * an error from the server from the wire), or finished successfully.
 *
 * Transport implementations can pass the signal to HTTP clients to ensure that
 * there are no unused connections leak.
 *
 * Returns a tuple:
 * [0]: The signal, which is also aborted if the optional deadline is reached.
 * [1]: Function to call if the Transport encountered an error.
 * [2]: Function to call if the Transport finished without an error.
 */
function setupSignal(opt) {
    const { signal, cleanup } = createDeadlineSignal(opt.timeoutMs);
    const controller = createLinkedAbortController(opt.signal, signal);
    return [
        controller.signal,
        function abort(reason) {
            // We peek at the signal because fetch() will throw an error on abort
            // that discards the signal reason.
            const e = controller.signal.aborted
                ? ConnectError.from(getAbortSignalReason(controller.signal), Code.Canceled)
                : ConnectError.from(reason);
            controller.abort(e);
            cleanup();
            return Promise.reject(e);
        },
        function done() {
            cleanup();
            controller.abort();
        },
    ];
}

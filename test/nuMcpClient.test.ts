/**
 * Unit tests for the JSON-RPC line-framing primitives backing the singleton
 * `nu --mcp` client. These are pure — no subprocess involved — so they can
 * exercise edge cases (malformed JSON, missing headers, mixed CRLF) cheaply.
 */
import { describe, expect, test } from "bun:test"
import {
    decodeMessage,
    encodeRequest,
    parseListCommandsOutput,
} from "../src/nuMcpClient.js"

describe("encodeRequest", () => {
    test("emits jsonrpc 2.0 + id + method + newline", () => {
        const line = encodeRequest(1, "tools/list", {})
        expect(line.endsWith("\n")).toBe(true)
        const parsed = JSON.parse(line)
        expect(parsed).toEqual({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
        })
    })

    test("omits params when not provided", () => {
        const line = encodeRequest(2, "ping")
        const parsed = JSON.parse(line)
        expect(parsed.method).toBe("ping")
        expect(parsed.id).toBe(2)
        expect("params" in parsed).toBe(false)
    })

    test("accepts string ids", () => {
        const line = encodeRequest("req-abc", "tools/call", { name: "x" })
        const parsed = JSON.parse(line)
        expect(parsed.id).toBe("req-abc")
        expect(parsed.params).toEqual({ name: "x" })
    })

    test("preserves nested params shape", () => {
        const params = { tool: "evaluate", args: { input: "1 + 1" }, n: 42 }
        const parsed = JSON.parse(encodeRequest(3, "tools/call", params))
        expect(parsed.params).toEqual(params)
    })

    test("output is exactly one line (no embedded newlines)", () => {
        const line = encodeRequest(4, "ping", { note: "single-line" })
        const inner = line.slice(0, -1)
        expect(inner.includes("\n")).toBe(false)
    })
})

describe("decodeMessage — responses", () => {
    test("parses a success response", () => {
        const msg = decodeMessage(
            '{"jsonrpc":"2.0","id":1,"result":{"foo":"bar"}}\n',
        )
        expect(msg.kind).toBe("response")
        if (msg.kind !== "response") throw new Error("unreachable")
        expect(msg.id).toBe(1)
        expect(msg.isError).toBe(false)
        expect(msg.payload).toEqual({ foo: "bar" })
    })

    test("parses an error response", () => {
        const msg = decodeMessage(
            '{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}',
        )
        expect(msg.kind).toBe("response")
        if (msg.kind !== "response") throw new Error("unreachable")
        expect(msg.id).toBe(7)
        expect(msg.isError).toBe(true)
        expect(msg.payload).toEqual({ code: -32601, message: "Method not found" })
    })

    test("parses a string-id response", () => {
        const msg = decodeMessage(
            '{"jsonrpc":"2.0","id":"abc","result":null}',
        )
        expect(msg.kind).toBe("response")
        if (msg.kind !== "response") throw new Error("unreachable")
        expect(msg.id).toBe("abc")
        expect(msg.isError).toBe(false)
        expect(msg.payload).toBeNull()
    })

    test("ignores trailing whitespace and CRLF", () => {
        const msg = decodeMessage(
            '{"jsonrpc":"2.0","id":1,"result":null}   \r\n',
        )
        expect(msg.kind).toBe("response")
    })
})

describe("decodeMessage — notifications", () => {
    test("classifies a no-id message as a notification", () => {
        const msg = decodeMessage(
            '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"reason":"x"}}',
        )
        expect(msg.kind).toBe("notification")
        if (msg.kind !== "notification") throw new Error("unreachable")
        expect(msg.method).toBe("notifications/cancelled")
        expect(msg.params).toEqual({ reason: "x" })
    })

    test("notification without params still classifies", () => {
        const msg = decodeMessage(
            '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        )
        expect(msg.kind).toBe("notification")
        if (msg.kind !== "notification") throw new Error("unreachable")
        expect(msg.method).toBe("notifications/initialized")
        expect(msg.params).toBeUndefined()
    })
})

describe("decodeMessage — error paths", () => {
    test("throws on empty line", () => {
        expect(() => decodeMessage("")).toThrow()
        expect(() => decodeMessage("   \r\n")).toThrow()
    })

    test("throws on invalid JSON", () => {
        expect(() => decodeMessage("not json")).toThrow()
    })

    test("throws on missing jsonrpc field", () => {
        expect(() => decodeMessage('{"id":1,"result":{}}')).toThrow()
    })

    test("throws on wrong jsonrpc version", () => {
        expect(() =>
            decodeMessage('{"jsonrpc":"1.0","id":1,"result":{}}'),
        ).toThrow()
    })

    test("throws on response with neither result nor error", () => {
        expect(() =>
            decodeMessage('{"jsonrpc":"2.0","id":1}'),
        ).toThrow()
    })

    test("throws on unclassifiable message (no id and no method)", () => {
        expect(() =>
            decodeMessage('{"jsonrpc":"2.0","params":{}}'),
        ).toThrow()
    })
})

describe("parseListCommandsOutput", () => {
    test("parses a simple name+signature+description line", () => {
        const r = parseListCommandsOutput(
            "where <condition>  - Filter values of an input list based on a condition.",
        )
        expect(r).toEqual([
            {
                name: "where",
                signature: "<condition>",
                description:
                    "Filter values of an input list based on a condition.",
            },
        ])
    })

    test("parses a multi-word name (subcommand)", () => {
        const r = parseListCommandsOutput(
            "polars arg-true  - Returns indexes where values are true.",
        )
        expect(r[0]).toEqual({
            name: "polars arg-true",
            signature: null,
            description: "Returns indexes where values are true.",
        })
    })

    test("treats {flags} as a signature start", () => {
        const r = parseListCommandsOutput(
            "pixi {flags} ...(args)  - Pixi - dev tool",
        )
        expect(r[0]).toEqual({
            name: "pixi",
            signature: "{flags} ...(args)",
            description: "Pixi - dev tool",
        })
    })

    test("treats ...(rest) as a signature start", () => {
        const r = parseListCommandsOutput(
            "__zoxide_z ...(rest)  - Jump to a directory using only keywords.",
        )
        expect(r[0]).toEqual({
            name: "__zoxide_z",
            signature: "...(rest)",
            description: "Jump to a directory using only keywords.",
        })
    })

    test("treats (optional) parens as a signature start", () => {
        const r = parseListCommandsOutput(
            "/autoload {flags} (target)  - Interact with a file from an autoload directory.",
        )
        expect(r[0]).toEqual({
            name: "/autoload",
            signature: "{flags} (target)",
            description:
                "Interact with a file from an autoload directory.",
        })
    })

    test("treats = as a signature element (alias form)", () => {
        const r = parseListCommandsOutput(
            "alias <name> = <initial_value>  - Alias a command (with optional flags) to a new name.",
        )
        expect(r[0]).toEqual({
            name: "alias",
            signature: "<name> = <initial_value>",
            description:
                "Alias a command (with optional flags) to a new name.",
        })
    })

    test("treats [optional] brackets as a signature start", () => {
        const r = parseListCommandsOutput(
            "foo [bar]  - test",
        )
        expect(r[0]).toEqual({
            name: "foo",
            signature: "[bar]",
            description: "test",
        })
    })

    test("line with no description (no separator)", () => {
        const r = parseListCommandsOutput("foo <bar>")
        expect(r[0]).toEqual({
            name: "foo",
            signature: "<bar>",
            description: null,
        })
    })

    test("empty lines and pure-whitespace lines are ignored", () => {
        const r = parseListCommandsOutput(
            "\n  \nwhere <condition>  - desc\n\n   \n",
        )
        expect(r.length).toBe(1)
        expect(r[0].name).toBe("where")
    })

    test("multiple lines parsed together preserve order", () => {
        const text =
            "where <condition>  - Filter\npolars arg-true  - Returns indexes"
        const r = parseListCommandsOutput(text)
        expect(r.length).toBe(2)
        expect(r[0].name).toBe("where")
        expect(r[1].name).toBe("polars arg-true")
    })

    test("trims trailing whitespace from description", () => {
        const r = parseListCommandsOutput("foo  - bar baz   ")
        expect(r[0].description).toBe("bar baz")
    })

    test("only-name line (no signature, no description)", () => {
        const r = parseListCommandsOutput("$nu")
        expect(r[0]).toEqual({
            name: "$nu",
            signature: null,
            description: null,
        })
    })
})

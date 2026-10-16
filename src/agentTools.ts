/** OpenAI function-calling tool schemas for the browser agent, plus local dispatch. */

import OpenAI from "openai";
import { BrowserActionError, BrowserController } from "./browserController";

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "navigate",
      description:
        "Navigate the browser to a specific URL. Use this to open a new page, go to a known " +
        "address, or recover by returning to a trusted starting point.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Fully qualified URL to navigate to, e.g. https://example.com"
          }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "click_coords",
      description:
        "Click at a specific pixel coordinate within the current viewport. Coordinates are " +
        "relative to the top-left corner of the viewport, matching the most recent screenshot " +
        "and interactive element list.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", description: "Horizontal pixel offset from the left edge of the viewport." },
          y: { type: "integer", description: "Vertical pixel offset from the top edge of the viewport." },
          label: { type: "string", description: "Short description of the element being clicked, for logging purposes." }
        },
        required: ["x", "y"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description:
        "Click a text input or textarea at the given coordinate, optionally clear its existing " +
        "value, and type the given text.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", description: "Horizontal pixel offset of the field." },
          y: { type: "integer", description: "Vertical pixel offset of the field." },
          text: { type: "string", description: "Text to type into the field." },
          clear: { type: "boolean", description: "Whether to clear the field before typing. Defaults to true." }
        },
        required: ["x", "y", "text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scroll_page",
      description: "Scroll the current page up or down by a pixel amount.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"] },
          amount: { type: "integer", description: "Pixels to scroll. Defaults to 600 when omitted." }
        },
        required: ["direction"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "key_press",
      description:
        "Press a single keyboard key or chord on the currently focused element, e.g. 'Enter', " +
        "'Escape', 'Tab', or 'Control+A'.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key or chord name understood by Playwright." }
        },
        required: ["key"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Pause execution for a short duration to allow slow content to load.",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "Seconds to wait, clamped between 0.1 and 10." }
        },
        required: ["seconds"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "finish_task",
      description:
        "Call this when the task has been completed and verified against the current page " +
        "state. Provide a concise summary of what was accomplished.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Concise summary of the completed task." }
        },
        required: ["summary"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fail_task",
      description:
        "Call this when the task cannot be completed, for example due to a dead end, missing " +
        "information, or a blocking error. Provide the reason.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why the task could not be completed." }
        },
        required: ["reason"]
      }
    }
  }
];

export interface ToolExecutionResult {
  ok: boolean;
  message: string;
  terminal?: "finish" | "fail";
}

export async function executeTool(
  name: string,
  toolInput: Record<string, unknown>,
  controller: BrowserController
): Promise<ToolExecutionResult> {
  try {
    switch (name) {
      case "navigate": {
        const url = String(toolInput.url);
        await controller.navigate(url);
        return { ok: true, message: `Navigated to ${url}.` };
      }
      case "click_coords": {
        const x = Math.trunc(Number(toolInput.x));
        const y = Math.trunc(Number(toolInput.y));
        if (Number.isNaN(x) || Number.isNaN(y)) {
          return { ok: false, message: `Invalid arguments for tool '${name}': x and y must be numbers` };
        }
        await controller.click(x, y);
        const label = typeof toolInput.label === "string" ? toolInput.label : "";
        return { ok: true, message: `Clicked at (${x}, ${y})${label ? ` on ${label}` : ""}.` };
      }
      case "type_text": {
        const x = Math.trunc(Number(toolInput.x));
        const y = Math.trunc(Number(toolInput.y));
        const text = String(toolInput.text ?? "");
        const clear = toolInput.clear === undefined ? true : Boolean(toolInput.clear);
        if (Number.isNaN(x) || Number.isNaN(y)) {
          return { ok: false, message: `Invalid arguments for tool '${name}': x and y must be numbers` };
        }
        await controller.typeText(x, y, text, clear);
        return { ok: true, message: `Typed ${text.length} character(s) at (${x}, ${y}).` };
      }
      case "scroll_page": {
        const direction = String(toolInput.direction) as "up" | "down";
        const amount = toolInput.amount === undefined ? 600 : Math.trunc(Number(toolInput.amount));
        await controller.scroll(direction, amount);
        return { ok: true, message: `Scrolled ${direction} by ${amount}px.` };
      }
      case "key_press": {
        const key = String(toolInput.key);
        await controller.keyPress(key);
        return { ok: true, message: `Pressed key '${key}'.` };
      }
      case "wait": {
        const seconds = Number(toolInput.seconds);
        if (Number.isNaN(seconds)) {
          return { ok: false, message: `Invalid arguments for tool '${name}': seconds must be a number` };
        }
        await controller.wait(seconds);
        return { ok: true, message: `Waited ${seconds.toFixed(1)} second(s).` };
      }
      case "finish_task": {
        const summary = typeof toolInput.summary === "string" ? toolInput.summary : "Task completed.";
        return { ok: true, message: summary, terminal: "finish" };
      }
      case "fail_task": {
        const reason = typeof toolInput.reason === "string" ? toolInput.reason : "Task failed.";
        return { ok: false, message: reason, terminal: "fail" };
      }
      default:
        return { ok: false, message: `Unknown tool '${name}'.` };
    }
  } catch (err) {
    if (err instanceof BrowserActionError) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: `Invalid arguments for tool '${name}': ${(err as Error).message}` };
  }
}

# First-time setup and model providers

## 1. Install the app

Install Git and Node.js **22.12 or newer** (with npm). Confirm `node --version`, `npm --version`, and `git --version` work. The desktop Electron dependency requires Node 22.12 or later.

Both the [Pilo repository](https://github.com/iamcharlesb/pilo) and its [browser-agent submodule](https://github.com/iamcharlesb/browser-agent) are public. No private-repository access is required. A ZIP of the parent repository omits the submodule; clone recursively instead.

```sh
git clone --recurse-submodules https://github.com/iamcharlesb/pilo.git
cd pilo
npm ci
npm --prefix node/browser_agent ci --legacy-peer-deps
cd node/browser_agent
npx playwright install chromium
cd ../..
npm run desktop
```

The runtime currently needs `--legacy-peer-deps` for its OpenAI SDK/Zod peer dependency conflict. Keep the launch terminal open. The desktop app uses `http://127.0.0.1:8766`. Google sign-in, MongoDB, voice services, and scheduled jobs are optional; none is required for your first chat.

## 2. Connect through Settings (easiest)

1. Open the gear icon → **Connect a model provider**.
2. Choose **OpenAI**, **Qwen (Alibaba Cloud)**, or **Kimi (Moonshot AI)**.
3. Paste an API key created in that provider's developer console. A consumer chat subscription or Kimi Code subscription is not a substitute for an API key for this endpoint.
4. The app fills the suggested model and endpoint. Open **Model and regional endpoint** if your provider account uses a different model, region, or API Host. Qwen keys must match their endpoint region; copy the API Host from the Model Studio console when it differs from the international preset.
5. Click **Save settings**. Pilo selects the saved model in the composer and uses it for subsequent requests without an app restart. Existing runs retain their client configuration.
6. Start with **Chat** and ask “Reply with one sentence confirming you can respond.” This test makes a billable model request. Saving settings itself makes no model request.

Blank key fields retain saved credentials. Keys are stored in the local ignored environment file with private permissions; saved keys are never returned to the page. Do not paste keys into bot conversations or screenshots. The existing advanced provider fields remain available for older setups.

The preset definitions are in [`config/providers.json`](../config/providers.json). These are starting points, not a promise that your account has access to every model. Models, endpoints, limits, and pricing are configuration, not hardcoded orchestration logic.

## 3. Or configure `.env`

From the Pilo repository root:

```sh
cp node/browser_agent/.env.example node/browser_agent/.env
```

Edit the new file with your editor. Choose **one** of the following configurations; leave the other provider keys blank. Never commit `.env`.

### OpenAI

```dotenv
BROWSER_AGENT_PROVIDER=openai
BROWSER_AGENT_MODEL=
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
```

### Qwen

```dotenv
BROWSER_AGENT_PROVIDER=qwen
BROWSER_AGENT_MODEL=
QWEN_API_KEY=YOUR_QWEN_API_KEY
```

`DASHSCOPE_API_KEY` is also accepted. `QWEN_BASE_URL` must match your key's region/workspace; the example uses the international Singapore endpoint. A different provider hosting a Qwen model belongs under **Other OpenAI-compatible API** rather than receiving your Alibaba key.

### Kimi

```dotenv
BROWSER_AGENT_PROVIDER=kimi
BROWSER_AGENT_MODEL=
KIMI_API_KEY=YOUR_KIMI_API_KEY
```

`MOONSHOT_API_KEY` is also accepted. This preset uses the Moonshot Open Platform endpoint, separate from Kimi Code.

The example file sets editable `OPENAI_MODEL`, `QWEN_MODEL`, `KIMI_MODEL`, their `*_BASE_URL` values, and their `*_API_MODE` (`responses` or `chat`). A nonempty `BROWSER_AGENT_MODEL` overrides the provider's model, so leave it empty when selecting through `BROWSER_AGENT_PROVIDER`.

Restart after manually editing `.env`. Inherited shell variables override files at startup; the app `.env` overrides matching parent-repository `.env` values. `BROWSER_AGENT_ENV_FILE` selects a single explicit file. If a saved setting seems to revert on restart, check inherited shell variables.

### Another compatible provider or local service

Select **Other OpenAI-compatible API** and supply its key, model ID, and API base URL, or set:

```dotenv
BROWSER_AGENT_PROVIDER=compatible
BROWSER_AGENT_MODEL=
COMPATIBLE_API_KEY=YOUR_PROVIDER_API_KEY
COMPATIBLE_MODEL=YOUR_MODEL_ID
COMPATIBLE_BASE_URL=https://YOUR_PROVIDER_HOST/v1
COMPATIBLE_API_MODE=chat
```

Pilo also retains Anthropic, xAI, Ollama, and Claude CLI support. For Ollama, install and run Ollama, pull your chosen model separately, then set `OLLAMA_MODEL` and select the Ollama entry. The Local Engine is a limited deterministic tool runner, not a general language model.

## 4. Try a browser task

Choose **Browse** for navigation and reading, **Act** for interactive browser tasks with approvals, or **Chat** for text tools without browser access. Opening the browser pane alone does not grant a Chat run browser tools. Use **Connect Apps** to connect your browser session. Models used for browser screenshots must support image input and tool calling; text-only models can still be used for text tasks.

Start with a read-only task. A task notification never starts a model request or recurring paid job. Configure recurring work separately and review its scope.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Repository not found | Check the public repository URL and GitHub connectivity, then retry `git submodule update --init --recursive`. |
| Empty `node/browser_agent` | Run `git submodule update --init --recursive`. |
| Electron cannot install | Use Node 22.12+; rerun the app dependency installation. |
| Model is not connected / 401 | Correct provider key, account access, API balance, and endpoint region. No other provider's key is used as a fallback. |
| Model not found / 404 | Edit the model ID and base URL; use a base URL, not a full `/chat/completions` path. |
| 400 or unsupported tools/images | Select a model supporting the task's input and tools; check its API mode and provider documentation. |
| Connection error / timeout / 429 | Check connectivity and provider status, quota, balance, and request limits. Avoid repeatedly retrying paid work. |
| Saved key disappears after restart | Check shell overrides and `BROWSER_AGENT_ENV_FILE`; blank key fields keep existing keys. |
| Port already in use | Run `npm run desktop:attach` to reuse the existing server. |
| Browser executable missing | Run `npx playwright install chromium` from `node/browser_agent`. |

## Architecture and extending providers

`providerRegistry.ts` reads deployment presets from `config/providers.json` and environment overrides. `runtimeConfig.ts` resolves a selected model's provider and API capabilities. `modelProviderFactory.ts` constructs the provider-specific client with its own key, URL, headers, timeout, and retry ownership. Both interactive engines receive that client; patch proposals use the same factory. Application policy checks, tool permissions, and known event handling stay in application code.

To add an OpenAI-compatible provider preset, extend the provider type and configuration registry, add credential-isolation and mocked tool-loop tests, and document its variables. Arbitrary compatible endpoints can already be configured without a new preset. A provider using an incompatible wire protocol needs a separate adapter; changing the key alone cannot translate protocols.

## Official provider references

- [OpenAI API keys](https://platform.openai.com/api-keys) and [GPT-5 mini capabilities](https://developers.openai.com/api/docs/models/gpt-5-mini).
- [Alibaba Model Studio API keys](https://www.alibabacloud.com/help/en/model-studio/get-api-key) and [regional OpenAI-compatible endpoints](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope).
- [Kimi Open Platform quickstart](https://platform.kimi.ai/docs/get-your-api-key).

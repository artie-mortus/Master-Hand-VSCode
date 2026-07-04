# Models are optional

Master Hand works with local heuristics only. Connecting a model adds richer suggestions plus Ask / Explain / Review / commit drafting.

**Master Hand: Select Model** opens a two-step picker: provider first, then a live model list (with context window and pricing where available). Supported providers:

- local **Ollama** (default `auto` uses it when running)
- **OpenAI**, **OpenRouter**, **Anthropic**, any OpenAI-compatible endpoint
- logged-in CLIs: **pi**, **codex**, **claude**, **gemini**

Picker choices are session-only; put persistent defaults in `settings.json` (`masterHand.model.*`). API keys come from environment variables. Use **Master Hand: Sign In / Check Provider** to check status or run a CLI login.

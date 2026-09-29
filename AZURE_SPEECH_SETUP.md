# SOMA HUB — Azure Speech setup

SOMA HUB R31.90 supports Azure Speech as the primary real-time inventory voice engine.

## Required server-side environment variables

- `AZURE_SPEECH_KEY` — Azure AI Speech resource key
- `AZURE_SPEECH_REGION` — Azure region, for example `westeurope`
- `SOMA_ALLOWED_ORIGINS` — optional comma-separated origins. Default: `https://mexpy88.github.io`

Never put `AZURE_SPEECH_KEY` in `index.html` or any client-side file.

## Backend

The repository already contains:

- `api/azure-speech-token.js`
- `vercel.json`

The endpoint exchanges the Azure resource key for a short-lived STS token and returns only the temporary token to the browser.

## Using the existing GitHub Pages frontend

If the backend is deployed at:

`https://YOUR-BACKEND.example.com`

open SOMA once with:

`https://mexpy88.github.io/NOVA-preview/?speechProxy=https://YOUR-BACKEND.example.com`

SOMA stores the backend origin locally in the browser and then requests:

`https://YOUR-BACKEND.example.com/api/azure-speech-token`

To replace the backend later, open SOMA again with a different `speechProxy` value.

## Azure behavior

When the backend is available SOMA uses:

1. Azure Speech SDK 1.51.0
2. Italian recognition (`it-IT`)
3. continuous real-time recognition
4. dynamic Phrase List from the current Master
5. phrase-list weight 2.0
6. automatic token refresh before expiry
7. Browser Live ASR fallback
8. local Whisper fallback only as final compatibility mode

Stock is never changed until the operator confirms the interpreted rows.

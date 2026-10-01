# Lumiverse Desk Companion

A first-party-style Spindle demonstration that puts a chosen character beside your desktop. Select and approve a screenshot or short recording in Lumiverse Desktop's native UI, receive a brief conversational reaction in that character's own voice, and optionally speak it using a configured TTS connection. Add a question when you want to steer the conversation.

This directory is a project, **not an initialized Git repository**. No repository, branch, commit, or remote is created. The manifest's GitHub address is a prospective address: change it if you publish somewhere else.

## Build and check

Requires Bun 1.4.2+ and the published `lumiverse-spindle-types@0.6.37` package. There are no local SDK paths or runtime dependencies.

```sh
bun install --frozen-lockfile
bun run check
```

The build emits `dist/backend.js`, `dist/frontend.js`, and a minified `dist/widget.js`. The native widget entry intentionally excludes the main drawer/onboarding code. `bun test` tests the actual worker controller with a mock host, input validation, source isolation, cancellation, capture release, bounds, voice recording, STT/TTS adapters, and widget interactions in jsdom. It does not capture your screen, access a real microphone, or call a paid provider. jsdom is development-only and is not bundled into the extension.

## Install and try it

1. Use the Lumiverse/backend and Desktop builds containing the capture integration. The manifest's version floor is 1.2.4, but the exact release number alone is insufficient: the widget checks `frontend-session-origin-v1` and `ctx.frontendSessionId` on the frontend; the worker separately checks `desktop-capture-worker-v1` and `frontend-session-routing-v1` on the backend. The server-routing capability is not a frontend capability and must not gate widget creation.
2. Create/publish the repository yourself, update `spindle.json`'s `github` if needed, and install through Lumiverse's Extensions panel. Its standard installer requires a repository URL; this demo does not modify the host database or invent a local-folder install API. The host can build the sources, or you can ship the generated `dist/` bundles.
3. Enable the extension and grant `ui_panels`, `characters`, `generation`, and the desired `screen_capture`/`screen_recording` permissions. Capture grants require administrator/owner approval; they never replace native consent. If the widget is not visible, open the **Desk Companion** drawer tab and press **Open companion widget**.
4. In the desktop tray, use **Browser → Enable Extension Screen Capture…**. Sign in through the native OAuth flow for the same account that owns the model connection. A browser cookie alone does not enable native capture.
5. Configure an image-capable model connection and an optional TTS connection in Lumiverse's normal Connection/Voice settings. The demo stores no API keys and creates no connections.
6. In the **Desk Companion** sidebar tab, choose a character, model connection, and desktop. Leave the question blank for a natural companion reaction, or configure an optional question/direction. Wait for **Settings synchronized**, then click **Look at my screen** in the compact widget. The native panel names the extension and destination. Select a source in the OS picker, preview it locally, then explicitly **Share This Capture** or **Stop & Discard**.
7. For video, select **Video clip**, 1–30 seconds, a video-capable desktop, and a Gemini connection (`google`, or a Gemini route through `google_vertex`). Provider hints are not proof that an arbitrary model supports media. The host and model still enforce actual support. Windows encoding is hardware-preferred; macOS is hardware-required.
8. To use a system floating pop-out, use the host's widget pop-out control or Desktop's **Floating Widgets** tray menu. The host loads `setupWidget(ctx, target)` from `dist/widget.js`; the extension registers the same single widget at index 0. No `window.open` or Tauri IPC is used.
9. In the sidebar, open **Character voice · text-to-speech** and choose a TTS connection. **Use character voice** applies a valid `character.extensions.ttsVoice` reference when that connection is visible to the account. A blank voice ID uses the connection default. In **Share workflow**, enable **Speak the character's reply automatically after an approved share** to include TTS in each share, or leave it off and use the widget's **Speak reply** manually. Speech sends reply text to the selected TTS provider. If browser autoplay is blocked, press Play in the widget's audio controls.
10. Optionally enable **Include a spoken question with each share**, select an STT connection, and configure a 1–15-second listening window. The same main action records that one microphone segment, stops automatically, transcribes through the selected STT provider, and combines it with any typed direction before opening native screen consent. No separate Record, Transcribe, Generate, or Speak buttons are required for the configured sequence.

Character choices are paginated 50 at a time; the active-chat character can also be included. Up to 200 model connections and the first 100 TTS connections are displayed. Preferences persist in the extension's per-user `companion-settings.json`, isolated even for operator-scoped installations. Replies and live workflow/speech state stay in worker memory: a reopened widget receives the latest state, but restarting the worker clears replies. No capture, transcript, or audio is persisted. Both speech options default off on first use; saved opt-ins do not start any service until the owner clicks Share.

## Sidebar and widget synchronization

All configuration lives in the **Desk Companion** sidebar. The floating widget contains the share/cancel triggers, reply, speech playback controls, Clear, and a Settings shortcut. Its root has an explicit bounded height, and its content scrolls when the viewport is small. For a native pop-out, Settings activates a registered sidebar in a connected main document; bring the main Lumiverse window forward if needed.

The worker owns settings revisions and broadcasts configuration, streamed replies, busy/cancel state, and speech status only to subscribed documents for the authenticated account. Different accounts never share that state. A share first claims the current configuration revision, so stale widgets cannot silently act on newer settings and multiple widgets cannot start competing microphone/capture workflows. Configuration is frozen while a share runs. Saving settings or reopening a widget never triggers capture, generation, STT, or TTS. Audio plays only in its originating widget; another synchronized widget can Stop speech or cancel the workflow without re-synthesizing the reply. Closing a subscribing document removes its subscription; closing the owner cancels its in-flight work.

## Default companion voice

The default prompt asks for a spontaneous, in-character reaction to one or two things that stand out, rather than a screen inventory or unsolicited advice. Responses normally target 1–3 short sentences (20–60 words), with more detail only when requested. The character's name, description/background, personality, scenario, greeting, dialogue examples, and portrayal instructions shape phrasing, rhythm, humor, and emotional tone; the prompt does not force a generic cheerful assistant voice. These are model instructions, not a guaranteed word-count limit.

An optional question overrides the default reaction request without removing the character context. For video-capable routes, the character is prompted to consider visible motion and changes across the approved clip. They are not told they have continuous live awareness. Plain-text output remains suitable for optional TTS; speech is automatic only when explicitly enabled for sharing.

## One-action sharing

Configure the workflow once in the sidebar; use one widget action to run it:

- Text only: approved capture → character reaction.
- Spoken reply: approved capture → character reaction → selected TTS voice.
- Voice question and spoken reply: timed microphone input → STT → approved capture → character reaction → TTS.

The main action runs the selected sequence. **Native source selection, preview, and Share are still mandatory**; one-action orchestration does not bypass screen consent. With voice input enabled, microphone audio goes to STT before screen consent; the workflow summary names the selected destination and duration. You may then discard the screen without sending it to a model. The included question is shown in the widget before native approval.

Both speech options default off. The selected voice is snapshotted when a share starts, and only that request's completed response can trigger TTS once. Partial tokens, other documents, failed/declined captures, or cancelled requests cannot trigger it. Stop disables pending automatic speech for the current share; Cancel/Clear/disposal also abort voice input and speech. STT failure stops before requesting screen capture; TTS failure leaves the generated text intact without retrying paid requests. Starting another share stops old playback before listening, avoiding a TTS-to-STT feedback loop.

Configuration remains memory-only and resets on reload or a newly created native pop-out. Microphone support depends on the secure browser/native webview and OS/browser microphone consent; unsupported windows can still use typed input. Browser consent is origin-level, **not a new per-extension Spindle permission**. This demo is not a hardened microphone sandbox for malicious frontend extensions; a host-brokered microphone capability and permission-gated Spindle STT consumer remain separate platform work. This change uses the existing authenticated STT REST endpoints rather than claiming such a worker API exists.

## Widget startup troubleshooting

Version 0.1.1 fixes a startup gate that incorrectly looked for the backend's `frontend-session-routing-v1` in the frontend descriptor. The frontend provides `frontend-session-origin-v1`; the worker still independently requires server routing. It also retries widget creation when UI Panels is granted after startup, and scopes permission/native-return events to the installation ID rather than the manifest identifier. Widget message IDs use `crypto.getRandomValues`, without requiring the secure-context-only `crypto.randomUUID` API; microphone security requirements are unchanged.

If upgrading from 0.1.0, publish the changed project, update the installed extension, and reload its frontend (or disable/re-enable it and refresh the desktop browser). Rebuilding the backend or the local project alone does not replace the extension bundle installed from its repository. Open the **Desk Companion** drawer tab to see startup status. Native screen-capture enablement controls capture requests, not widget registration. No backend/Tauri rebuild is needed for this extension-only fix.

## Generation request troubleshooting

Version 0.1.3 fixes the raw generation request's missing model/provider fields.
A `connection_id` resolves the stored credentials and endpoint; raw generation
still needs the explicit selected model. Capture-bound generation rejects a
request that does not exactly match the approved model and connection, before
any pixels reach the provider. The extension now supplies both fields from the
owned connection fetched for the share; the host's destination checks are unchanged.

Gemini requests allow a 4,096-token generation budget, including internal reasoning,
while visible replies remain bounded to 4,000 characters and the default prompt
still asks for a concise reaction. Gemini 3 requests use low thinking effort without
displaying thoughts; other routes retain the reasoning-off override. A short text
target is not the same as a thinking-inclusive token budget. This reduces empty
responses caused by consuming a small output budget on reasoning, but does not
guarantee completion for every provider request.

Failures distinguish a changed capture destination, credential/access denial,
quota limits, invalid provider requests, service failures, token-budget exhaustion,
blocked responses, missing terminal completion, and empty text. Raw provider error
bodies, credentials, screen contents, and reasoning are never echoed into widget
state. Failed or incomplete responses do not trigger automatic TTS, and no capture
or paid generation is retried automatically.

Publish/update the installed extension and reload its frontend after upgrading;
rebuilding only the Tauri client or backend does not replace an installed extension
bundle. No backend/Tauri rebuild or Spindle SDK update is required for this fix.

## API integration

| Feature | Implementation |
| --- | --- |
| System floating widgets | `ctx.ui.createFloatWidget`, distinct `setup`/`setupWidget` entries, host-managed pop-out and scoped return handling |
| Desktop capture | Worker-only `spindle.desktop.capture.listDevices`, `request`, and `release`; opaque single-use handles never go to the frontend |
| Generation assembly | `assembleMessages` creates provider-neutral messages from the owned character card, user question, and `{ type: 'desktop_capture', asset_id }`; `spindle.generate.rawStream` dispatches them through the exact selected connection |
| Character API | `spindle.characters.list/get` with the trusted frontend sender's user ID; reference fields are bounded and included only in the worker's prompt |
| TTS | Existing authenticated `GET /api/v1/tts-connections` and `POST /api/v1/tts/synthesize` APIs, called same-origin from the originating document; a memory-only blob feeds a normal audio player |
| STT | Existing authenticated `GET /api/v1/stt-connections` and multipart `POST /api/v1/stt/transcribe`; explicit timed audio-only microphone input, memory-only audio, no provider keys in the widget |

There is currently **no `spindle.tts.synthesize` worker API**. `registerTtsEngine`/`providers.tts.register` are for supplying engines, not consuming a user's configured TTS connection. This project uses the actual REST synthesis API instead of inventing a worker method or registering its own provider.

Likewise `registerSttEngine` supplies an engine; there is no configured-connection `spindle.stt.transcribe` consumer in the pinned 0.6.37 SDK. Screen capture permission does not authorize microphone access or create an STT permission. Microphone consent and the explicit per-share opt-in are separate.

`spindle.generate.assemble` is also **not** a general-purpose UI prompt builder: it requires an active interceptor's frozen retrieval context. This manual sidecar constructs raw messages explicitly. It does not register interceptors, mutate chats, or run Loom/lorebook/persona retrieval. Selected character description, personality, scenario, examples, and instruction references are included; no normal-chat history is appended.

## Safety and cancellation

- Each observation is user-triggered and names a model/device. There are no background screenshots/listening, automatic retries, rolling buffers, tool calls, filesystem access, computer control, or system-audio capture. Microphone audio is captured only for the explicitly enabled, bounded voice-question step, never attached to the screen recording or sent directly to the text generation model.
- The worker gets user/document identity from `onFrontendMessage`, never from payload fields. Generation responses target the requesting document; synchronized metadata/reply snapshots intentionally reach registered documents for the same authenticated user, each with an exact `frontendSessionId`. Audio is not broadcast. Other users and unsubscribed documents cannot control the shared workflow. State is bounded to 128 accounts, 16 subscribed views per account, and 32 queued state operations per account. One in-flight observation per account, at most eight globally, and a ten-second request cooldown reduce prompt abuse; busy/cooldown checks run before microphone input. Native host quotas still apply.
- Capture handles are consumed by raw generation and released in `finally`, including cancellation, stale handles, model failure, output limits, and timeout. No capture bytes, IDs, files, leases, or OAuth credentials reach the widget. Errors are fixed messages, not raw provider errors or capture contents. Reasoning tokens are not shown or spoken.
- **Cancel request** aborts an in-flight generation. The current capture request API has no request ID/cancel method or `AbortSignal`. It therefore cannot dismiss an already-open native picker or immediately stop native recording from the worker. Use **Stop & Discard** in the trusted native panel. A cancelled worker waits for that capture to resolve/expire, releases any eventual handle, and never dispatches it to a model. Another observation is blocked until that pending request finishes.
- Closing the originating document, revoking permissions, or unloading the extension aborts worker generation. Native capture also has independent host/device cancellation and expiry. Already released uploads cannot be recalled from a model/STT/TTS provider. Aborting the browser STT request does not guarantee that processing or billing stops after the backend/provider accepts it; local cancellation prevents later screen/model dispatch and playback.
- Replies are capped at 4,000 characters; generation has a 90-second deadline and the capture/generation workflow a four-minute deadline. Voice input is limited to 15 seconds and 4 MiB; microphone tracks stop before uploading, including error/cancellation cleanup. The input preparation deadline is 60 seconds; transcription JSON is limited to 32 KiB and the combined typed/spoken question to 1,200 characters. TTS is capped at 2,400 characters, 45 seconds, and 8 MiB of audio. Connection-list JSON is limited to 1 MiB. Media object URLs are revoked on stop, clear, replacement, and teardown.
- The extension persists only validated, per-user configuration: selected resource IDs, capture/workflow preferences, optional typed direction, and voice settings. It writes no captures, transcripts, replies, audio, or chat messages to storage. Configuration storage is not a secret vault; do not put credentials in the optional direction. The host/model/TTS providers, browser/framework copies, OS paging, and provider-side retention have their own policies. Do not share sensitive screens merely because they can be captured.
- Linux capture and rolling replay buffers remain unavailable. The demo never requests `mode: 'replay'`.

## Live acceptance checklist

- Test screenshot and 1-/30-second video flows in the main document and in a native pop-out; confirm source selection, native preview, explicit Share/Discard, exact model destination, no audio in the recording, and the correct character voice.
- Edit configuration in the sidebar while opening, closing, returning, and reopening native pop-outs. Confirm the compact widget stays scrollable and immediately uses saved settings; reopening never replays paid TTS.
- Open two documents for the same account and a document for another account. Confirm registered views of the same account mirror settings/replies/busy and speech state, only the requester receives audio, and shared cancellation/Stop controls work. Ensure another account or an unsubscribed document receives nothing and cannot cancel the workflow.
- Cancel while waiting for native consent, then discard there; repeat while streaming generation and while synthesizing speech. Close the native source, lock/sleep the desktop, disable native capture, switch instances, revoke grants, and unload the extension. Confirm no delayed model dispatch or speaking.
- Try unsupported models/devices, expired handles, missing character/connection, repeated clicks, oversized replies/audio, provider failures, and autoplay blocking. Render model output such as `<script>` as plain text, never executable markup.
- Test both speech options off/on and the complete one-action flow. Verify no microphone request on widget load, timely track shutdown, cancellation during a pending OS microphone prompt and STT upload, no screen prompt after failed STT, and exactly one TTS request after native Share. Check typed-input fallback in each native webview; OS microphone configuration/consent and autoplay are not bypassed.
- Inspect persistence/logs: no extension-written capture files or transcripts, no chat-history writes, no capture-derived provider payload in request history. Check actual GPU encode activity on Windows rather than assuming the acceleration preference proves hardware use.

## Layout

`src/worker.ts` owns the workflow and authorization-bound routing; `src/companion-state.ts` owns per-user persistence, subscriptions, and shared workflow/speech state. `src/settings.ts` validates preferences. `src/prompt.ts` assembles messages. `src/companion-view.ts` renders separate settings and trigger surfaces; `src/companion-widget.ts` registers its bounded host widget. `src/frontend.ts` adds the sidebar configuration/onboarding; `src/widget.ts` is the lightweight native entry. `src/speech.ts` wraps bounded authenticated TTS requests. `src/speech-input.ts` records bounded voice input and wraps existing STT endpoints; `src/share-workflow.ts` sequences input and request-bound automatic speech. `tests/` contains non-billable contract/controller and widget lifecycle tests.

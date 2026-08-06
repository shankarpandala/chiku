# Chiku Live

The realtime surface: Chiku sees the child through the camera, talks with them,
and the child answers with their body. Everything runs on this device — camera
frames and landmarks never leave it, and there is no hosted LLM on the kid path.

## Run it

```sh
corepack pnpm install
corepack pnpm --filter @chiku/live vendor:vision   # once: downloads MediaPipe models (~12MB, gitignored)
corepack pnpm dev:live                             # http://localhost:5175
```

## Run it on a phone or tablet

Reaching the app from another device is not enough — `getUserMedia` needs a
**secure context**, and a plain-http LAN address is not one. Load it over
`http://<lan-ip>:5175` and the page appears but the camera never prompts.

So there is a second script that serves HTTPS with a local cert:

```sh
# once, with YOUR lan ip (ipconfig getifaddr en0)
mkdir -p apps/live/certs && cd apps/live/certs && openssl req -x509 \
  -newkey rsa:2048 -nodes -keyout dev-key.pem -out dev-cert.pem -days 365 \
  -subj "/CN=chiku-live-dev" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<your-lan-ip>"

corepack pnpm dev:live:lan     # https://<lan-ip>:5175
```

The cert is self-signed, so each device shows a warning once —
**Advanced → Proceed** on Chrome/Android, **Show Details → visit this website**
on Safari/iOS. After that the camera prompts normally. `certs/` is gitignored.

`dev:live` is unchanged and stays plain HTTP: `localhost` is already a secure
context, so HTTPS there would only add a warning for nothing.

## Layout

- `src/vision/` — on-device MediaPipe. `stability.ts` is the forgiveness layer
  (hysteresis, teleport rejection, presence fades, subject lock); `quad.ts` +
  `quad-detect.ts` are the hand-made magic window.
- `src/voice/` — speechSynthesis out, push-to-talk SpeechRecognition in, gated
  on **on-device** recognition (see the §9.1 amendment in the architecture doc).
- `src/activities/` — the pool. `assist.ts` is the mercy ladder. Adding a file
  here that exports a `create…Activity` factory and forgetting to schedule it
  in `index.ts` **fails the build** — that is deliberate.
- `src/components/`, `src/surfaces/live/` — the stage, the window, the surface.

## Known-unverified

No camera has ever seen this. Every threshold — hue bands, `HIDE_RADIUS`,
`ARM_REACH`, child-hand finger angles — is reasoned geometry pinned by
fixtures, not measured against a real child. All Telugu copy needs a native
speaker before family testing.

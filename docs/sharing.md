# Sharing

The main task is to deliver an animated file to a conversation.
Copying a link remains a separate action.
App names belong in this evidence record, not in destination-specific UI buttons.

## Formats

| Format     | Role                                                       | Tradeoff                                              |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| MP4        | Desktop default for ordinary clips; small gallery previews | No transparency or guaranteed looping                 |
| GIF        | Mobile default, native image actions; default for stickers | Larger files, limited colours                         |
| WebP       | Small animated sticker previews                            | Receiver processing can flatten animation             |
| Still GIF  | Paused previews                                            | Single frame                                          |
| PNG / APNG | Not exposed                                                | Clipboard or receiver processing can remove animation |
| WebM       | Not exposed                                                | No established benefit across all target apps         |

These choices follow the [Giphy rendition guide][giphy] and recipient evidence below.
Share original, full-duration renditions; do not substitute shortened previews.
Do not transcode animation through a canvas or label a still PNG as a copied GIF.
GIF is available alongside MP4 because a video attachment is not always a looping image.

## Delivery

Prepare only the selected format before the final sharing click.
On touch or narrow layouts, one tap opens the original GIF above the format controls.
The gallery still uses small, lazy previews and does not fetch originals merely while browsing.
Without file-sharing API support, only the native image loads on opening.
Validated download bytes are then prepared only when Download is requested.
The image remains an ordinary HTTPS `img`, with no custom long-press interception.
The desktop overlay prepares a GIF only after hover or keyboard focus.
Leaving the card cancels preparation and releases the prepared file.
Check the actual File with `navigator.canShare({ files })`.
Share that file alone, with no URL or text that could change how a recipient handles it.
The native share call must retain the fresh user activation.
Cancellation is quiet; failure leaves download available.
Format changes abort stale work before it can replace the selected file.

| Environment               | File-sharing path                                                 |
| ------------------------- | ----------------------------------------------------------------- |
| Chrome desktop / Android  | Use native file sharing when the runtime check succeeds           |
| Firefox desktop / Android | Native image menu or download; file-sharing API support is absent |
| Chrome / Firefox on iOS   | Check the actual browser integration at runtime                   |

[Browser compatibility data][compat] distinguishes file sharing from link sharing.
A URL-only share implementation must never become the primary media action.
On desktop, a downloaded file can also be dragged or copied from the file manager.
Native image copying from the GIF preview remains an additional browser-dependent route.
Firefox Android exposes content sharing through its [native long-press menu][firefox-share].
The site cannot open that browser menu or choose its target programmatically.
The Firefox Windows preference is described in [verification.md](verification.md).

`canShare` does not identify recipient apps or establish successful delivery.
A resolved [Web Share][share] promise can mean only that the OS opened its share UI.
The site cannot choose a system action such as Copy; the user selects the target.
Report a handoff, never that a message was sent or will autoplay.

## Recipient evidence

Reviewed on 2026-09-20; no messages were sent to test these apps.

| Recipient | Evidence for external files                                                                 | Still unverified                                                   |
| --------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Teams     | [MP4/H.264 playback recommended][teams-video]; [device attachments supported][teams-files]  | External GIF inline animation, autoplay, share-target availability |
| WhatsApp  | [MP4 listed as supported consumer media][whatsapp]                                          | External GIF handoff and animation across clients                  |
| Signal    | [Desktop preserves GIFs and supports video][signal]; [iOS supports GIF and MP4][signal-ios] | OS share-target behavior across devices and client versions        |

Signal's GIF-style video behavior uses a separate attachment flag.
An external MP4 does not gain that flag merely by being silent or short.
Its image pipeline can re-encode WebP/APNG through a [canvas][signal-canvas].
That is a concrete reason not to offer these as universal animation exports.
Built-in GIF-picker documentation does not establish support for arbitrary external GIFs.
WhatsApp Business API rules are not evidence for the consumer application's share flow.

## Verification boundary

Browser tests verify file bytes, MIME types, user activation and unsupported-API fallbacks.
They also exercise cancellation, preparation errors, format races and cleanup.
Real media checks establish that the sampled GIF animates and the MP4 decodes.
Receiving-app delivery, animation and autoplay still require device tests.
Mobile viewport tests do not establish native Firefox Android menu behavior on a phone.
Phone tests need a secure origin; ordinary LAN HTTP does not exercise Web Share correctly.

[giphy]: https://developers.giphy.com/docs/optional-settings/
[compat]: https://github.com/mdn/browser-compat-data/blob/main/api/Navigator.json
[firefox-share]: https://support.mozilla.org/en-US/kb/how-do-i-share-things-firefox-android
[share]: https://www.w3.org/TR/web-share/
[teams-video]: https://support.microsoft.com/en-us/onedrive/video-formats-you-can-play-on-microsoft-365
[teams-files]: https://support.microsoft.com/en-us/teams/chat/send-a-file-picture-or-link-in-microsoft-teams
[whatsapp]: https://faq.whatsapp.com/1096027074615511/?cms_platform=android&locale=fr_FR
[signal]: https://github.com/signalapp/Signal-Desktop/blob/main/ts/util/Attachment.std.ts
[signal-ios]: https://github.com/signalapp/Signal-iOS/blob/main/SignalServiceKit/Util/MimeTypeUtil.swift
[signal-canvas]: https://github.com/signalapp/Signal-Desktop/blob/main/ts/util/scaleImageToLevel.preload.ts

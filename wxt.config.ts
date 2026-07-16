import { defineConfig } from "wxt";

const isolatedContentScripts = [
  "gloss-config.js",
  "shared.js",
  "content-utils.js",
  "content-state.js",
  "content-detect.js",
  "content-render.js",
  "content-observers.js",
  "content-floating.js",
  "content-selection.js",
  "content-styles.js",
  "content-translate.js",
  "content-subtitles.js",
  "content.js"
];

export default defineConfig({
  publicDir: "extension",
  manifest: ({ browser }) => {
    const isSafari = browser === "safari";
    return {
      name: "Gloss — Immersive Translator",
      description: "Top-tier bilingual page translation powered by the Gloss macOS app.",
      action: {
        default_popup: "popup.html",
        default_title: "Gloss — Translate this page"
      },
      background: {
        service_worker: "background.js"
      },
      content_scripts: [
        ...(!isSafari
          ? [{
              matches: ["<all_urls>"],
              js: ["route-patch.js"],
              run_at: "document_start" as const,
              world: "MAIN" as const
            }]
          : []),
        {
          matches: ["<all_urls>"],
          js: isolatedContentScripts,
          run_at: "document_idle" as const
        }
      ],
      host_permissions: [
        "http://127.0.0.1/*",
        "http://localhost/*",
        ...(!isSafari ? [
          "https://www.youtube.com/api/timedtext*",
          "https://youtube.com/api/timedtext*",
          "https://www.youtube-nocookie.com/api/timedtext*"
        ] : [])
      ],
      permissions: [
        "activeTab",
        "scripting",
        "storage",
        "tabs",
        ...(isSafari ? ["nativeMessaging"] : [])
      ]
    };
  }
});

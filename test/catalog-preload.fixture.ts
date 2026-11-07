const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) === "https://api.qoder.com/api/v1/forward/models")
    return new Response(
      JSON.stringify({
        data: [
          { id: "auto", display_name: "Auto", is_enabled: true },
          {
            id: "next_generation",
            display_name: "Next Generation",
            is_enabled: true,
          },
          { id: "api_only", display_name: "API Only", is_enabled: true },
        ],
      }),
      { status: 200 },
    );
  return originalFetch(input, init);
};

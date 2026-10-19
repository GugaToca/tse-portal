
const TSE_CONFIG_URL =
  "https://resultados.tse.jus.br/oficial/ele2026/comum/config/ele-c.json";

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

export default async (request) => {
  const url = new URL(request.url);
  const path = url.pathname
    .replace(/^\/\.netlify\/functions\/api/, "")
    .replace(/^\/api/, "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  if (path === "/health") {
    return json({
      status: "ok",
      service: "tse-portal-api",
      data_source: "not_connected",
      message: "API ativa; conexão oficial ainda não validada."
    });
  }

  if (path === "/tse-config") {
    try {
      const response = await fetch(TSE_CONFIG_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000)
      });

      if (!response.ok) {
        return json({
          status: "source_unavailable",
          source: "TSE",
          http_status: response.status,
          message:
            "A configuração não foi obtida. Verifique o caminho oficial na documentação antes de tentar novamente."
        }, 502);
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) {
        return json({
          status: "invalid_response",
          message: "O TSE não retornou uma resposta JSON."
        }, 502);
      }

      const config = await response.json();

      return json({
        status: "connected",
        source: "TSE",
        config_url: TSE_CONFIG_URL,
        retrieved_at: new Date().toISOString(),
        config
      });
    } catch {
      return json({
        status: "source_unavailable",
        source: "TSE",
        message:
          "Não foi possível consultar a configuração. Verifique a conectividade e o caminho documentado."
      }, 502);
    }
  }

  return json({
    error: "not_found",
    available_endpoints: ["/api/health", "/api/tse-config"]
  }, 404);
};

export default async (request, context) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/.netlify\/functions\/api/, "").replace(/^\/api/, "") || "/";

  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type"
  };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  if (path === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      service: "tse-portal-api",
      data_source: "not_connected",
      message: "Estrutura inicial ativa. O coletor oficial do TSE ainda precisa ser implementado e validado."
    }), { status: 200, headers });
  }

  return new Response(JSON.stringify({
    error: "not_implemented",
    message: "Este endpoint ainda não está conectado aos dados oficiais do TSE.",
    path
  }), { status: 501, headers });
};

const TSE_BASE = "https://resultados.tse.jus.br";
const CACHE_TTL_MS = 60_000;
const memoryCache = new Map();

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

function getPath(url) {
  return url.pathname
    .replace(/^\/.netlify\/functions\/api/, "")
    .replace(/^\/api/, "") || "/";
}

async function fetchJsonOnce(key, sourceUrl) {
  const cached = memoryCache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return { ok: true, data: cached.data, cached: true, sourceUrl };
  }

  // Uma única tentativa por chamada. Não repetir 404, para evitar bloqueio do TSE.
  const response = await fetch(sourceUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    return { ok: false, status: response.status, sourceUrl };
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("json")) {
    return { ok: false, status: 502, invalidContentType: true, sourceUrl };
  }

  const data = await response.json();
  memoryCache.set(key, { time: Date.now(), data });
  return { ok: true, data, cached: false, sourceUrl };
}

function summarizeConfig(config) {
  const elections = [];
  for (const pleito of config?.pl || []) {
    for (const election of pleito?.e || []) {
      const offices = [];
      const ufs = [];
      for (const coverage of election?.abr || []) {
        if (coverage?.cd) ufs.push(coverage.cd);
        for (const office of coverage?.cp || []) {
          offices.push({ code: office.cd, name: office.ds, type: office.tp });
        }
      }
      elections.push({
        pleito_code: pleito.cd,
        cycle: pleito.c,
        election_code: election.cd,
        second_round_election_code: election.cdt2 || null,
        name: election.nm,
        round: election.t,
        election_type: election.tp,
        scopes: [...new Set(ufs)],
        offices
      });
    }
  }
  return elections;
}

export default async (request) => {
  const url = new URL(request.url);
  const path = getPath(url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  if (path === "/health") {
    return json({
      status: "ok",
      service: "tse-portal-api",
      data_source: "not_yet_validated",
      endpoints: ["/api/health", "/api/tse-config?ambiente=simulado", "/api/tse-config?ambiente=oficial", "/api/elections?ambiente=simulado", "/api/elections?ambiente=oficial"]
    });
  }

  if (path === "/tse-config" || path === "/elections") {
    const ambiente = (url.searchParams.get("ambiente") || "oficial").toLowerCase();
    if (!["oficial", "simulado"].includes(ambiente)) {
      return json({ error: "invalid_environment", allowed: ["oficial", "simulado"] }, 400);
    }

    // O ciclo faz parte do caminho conforme EA11. Estes são os ciclos indicados
    // na documentação/URL de referência recebida; o oficial pode não estar publicado
    // ou ter ciclo diferente. Não se tenta descobrir caminhos por tentativa e erro.
    const cycle = ambiente === "simulado" ? "simulado2026" : "ele2026";
    const sourceUrl = `${TSE_BASE}/${ambiente}/${cycle}/comum/config/ele-c.json`;

    try {
      const result = await fetchJsonOnce(`ea11:${ambiente}:${cycle}`, sourceUrl);
      if (!result.ok) {
        return json({
          status: "source_unavailable",
          source: "TSE",
          environment: ambiente,
          attempted_url: sourceUrl,
          http_status: result.status,
          message: result.invalidContentType
            ? "O endereço não retornou JSON. Nenhuma nova tentativa automática foi feita."
            : result.status === 404
              ? "O TSE retornou 404 para este caminho. O ciclo/caminho oficial precisa ser confirmado; nenhuma URL alternativa foi tentada para evitar bloqueio."
              : "Não foi possível obter a configuração. Nenhuma repetição automática foi feita."
        }, 502);
      }

      const config = result.data;
      if (!config || !Array.isArray(config.pl) || !Array.isArray(config.arq)) {
        return json({ status: "invalid_config", source: "TSE", message: "A resposta não corresponde à estrutura esperada do EA11." }, 502);
      }

      if (ambiente === "oficial" && config.f !== "o") {
        return json({
          status: "wrong_environment_phase",
          source: "TSE",
          environment: ambiente,
          phase: config.f || null,
          message: "A configuração não indica fase oficial. Ela não será apresentada como resultado real."
        }, 502);
      }

      if (path === "/elections") {
        return json({
          status: "connected",
          source: "TSE",
          environment: ambiente,
          phase: config.f === "o" ? "oficial" : config.f === "s" ? "simulado" : "unknown",
          generated_date: config.dg || null,
          generated_time: config.hg || null,
          generation_id: config.idg || null,
          cycle,
          elections: summarizeConfig(config),
          cached: result.cached
        });
      }

      return json({
        status: "connected",
        source: "TSE",
        environment: ambiente,
        phase: config.f === "o" ? "oficial" : config.f === "s" ? "simulado" : "unknown",
        config_url: sourceUrl,
        retrieved_at: new Date().toISOString(),
        generated_date: config.dg || null,
        generated_time: config.hg || null,
        generation_id: config.idg || null,
        cycle,
        elections_count: summarizeConfig(config).length,
        config,
        cached: result.cached
      });
    } catch (error) {
      return json({
        status: "source_unavailable",
        source: "TSE",
        environment: ambiente,
        attempted_url: sourceUrl,
        message: error?.name === "TimeoutError"
          ? "O TSE não respondeu dentro de 8 segundos. Não houve repetição automática."
          : "Falha ao consultar ou interpretar a resposta do TSE. Não houve repetição automática."
      }, 502);
    }
  }

  return json({ error: "not_found", available_endpoints: ["/api/health", "/api/tse-config", "/api/elections"] }, 404);
};

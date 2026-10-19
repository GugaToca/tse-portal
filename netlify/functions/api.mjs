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

function normalizeUf(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeOffice(value) {
  const raw = String(value || "").trim();
  if (!/^\d{1,4}$/.test(raw)) return null;
  return raw.padStart(4, "0");
}

function normalizeElection(value) {
  const raw = String(value || "").trim();
  if (!/^\d{1,6}$/.test(raw)) return null;
  return raw.padStart(6, "0");
}

const VALID_UFS = new Set(["br", "ac", "al", "ap", "am", "ba", "ce", "df", "es", "go", "ma", "mt", "ms", "mg", "pa", "pb", "pr", "pe", "pi", "rj", "rn", "rs", "ro", "rr", "sc", "sp", "se", "to"]);


const UF_NAMES = {
  ac: "Acre", al: "Alagoas", ap: "Amapá", am: "Amazonas", ba: "Bahia",
  ce: "Ceará", df: "Distrito Federal", es: "Espírito Santo", go: "Goiás",
  ma: "Maranhão", mt: "Mato Grosso", ms: "Mato Grosso do Sul", mg: "Minas Gerais",
  pa: "Pará", pb: "Paraíba", pr: "Paraná", pe: "Pernambuco", pi: "Piauí",
  rj: "Rio de Janeiro", rn: "Rio Grande do Norte", rs: "Rio Grande do Sul",
  ro: "Rondônia", rr: "Roraima", sc: "Santa Catarina", sp: "São Paulo",
  se: "Sergipe", to: "Tocantins"
};

async function mapStateResult({ ambiente, uf, cargo, election }) {
  const cycle = ambiente === "simulado" ? "simulado2026" : "ele2026";
  const host = ambiente === "simulado" ? "https://resultados-sim.tse.jus.br" : "https://resultados.tse.jus.br";
  const fileName = `${uf}-c${cargo}-e${election}-u.json`;
  const sourceUrl = `${host}/${ambiente}/${cycle}/${Number(election)}/dados/${uf}/${fileName}`;
  try {
    const result = await fetchJsonOnce(`result:${ambiente}:${uf}:${cargo}:${election}`, sourceUrl);
    if (!result.ok) return { uf: uf.toUpperCase(), state: UF_NAMES[uf], status: "unavailable", http_status: result.status };
    if (ambiente === "oficial" && result.data?.f !== "o") return { uf: uf.toUpperCase(), state: UF_NAMES[uf], status: "unavailable", message: "phase_not_official" };
    const summary = summarizeResults(result.data);
    return {
      uf: uf.toUpperCase(), state: UF_NAMES[uf], status: "connected",
      sections_total: summary.turnout.sections_total,
      sections_counted: summary.turnout.sections_counted,
      sections_counted_percent: summary.turnout.sections_counted_percent,
      electors_total: summary.turnout.electors_total,
      votes_total: summary.turnout.votes_total,
      updated_date: summary.updated_date,
      updated_time: summary.updated_time,
      leader: summary.candidates[0] ? {
        name: summary.candidates[0].name,
        party: summary.candidates[0].party,
        votes: summary.candidates[0].votes,
        vote_percent: summary.candidates[0].vote_percent
      } : null,
      cached: result.cached
    };
  } catch (error) {
    return { uf: uf.toUpperCase(), state: UF_NAMES[uf], status: "unavailable", message: error?.name === "TimeoutError" ? "timeout" : "fetch_error" };
  }
}

async function runWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function summarizeResults(data) {
  const candidates = [];
  const seen = new Set();
  for (const office of data?.carg || []) {
    for (const group of office?.agr || []) {
      for (const party of group?.par || []) {
        for (const candidate of party?.cand || []) {
          const key = String(candidate?.sqcand || candidate?.n || candidate?.nm || "");
          if (!key || seen.has(key)) continue;
          seen.add(key);
          candidates.push({
            id: candidate.sqcand || candidate.n || null,
            number: candidate.n || null,
            name: candidate.nm || candidate.nmu || "Nome não informado",
            party: party.sg || party.nm || group.nm || null,
            votes: Number(candidate.vap || 0),
            vote_percent: Number(String(candidate.pvapn || candidate.pvap || "0").replace(",", ".")),
            status: candidate.st || null,
            situation: candidate.dvt || null
          });
        }
      }
    }
  }
  candidates.sort((a, b) => b.votes - a.votes);
  const sections = data?.s || {};
  const electors = data?.e || {};
  return {
    election_code: data?.ele || null,
    round: data?.t || null,
    phase: data?.f === "o" ? "oficial" : data?.f === "s" ? "simulado" : "desconhecida",
    updated_date: data?.dg || data?.dt || null,
    updated_time: data?.hg || data?.ht || null,
    office: (data?.carg || []).map(item => ({ code: item.cd || null, name: item.nmn || item.nmm || item.nmf || null })),
    turnout: {
      sections_total: Number(sections.ts || 0),
      sections_counted: Number(sections.si || 0),
      sections_counted_percent: Number(String(sections.psin || sections.pstn || sections.pst || "0").replace(",", ".")),
      electors_total: Number(electors.te || 0),
      votes_total: Number(data?.v?.tv || 0)
    },
    candidates
  };
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
      endpoints: ["/api/health", "/api/tse-config?ambiente=simulado", "/api/tse-config?ambiente=oficial", "/api/elections?ambiente=simulado", "/api/elections?ambiente=oficial", "/api/results?ambiente=oficial&uf=sp&cargo=0003&eleicao=6259", "/api/map?ambiente=oficial&cargo=0003&eleicao=6259"]
    });
  }

  if (path === "/map") {
    const ambiente = (url.searchParams.get("ambiente") || "oficial").toLowerCase();
    const cargo = normalizeOffice(url.searchParams.get("cargo") || "0003");
    const election = normalizeElection(url.searchParams.get("eleicao") || "6259");
    if (!["oficial", "simulado"].includes(ambiente)) return json({ error: "invalid_environment", allowed: ["oficial", "simulado"] }, 400);
    if (!cargo || !election) return json({ error: "invalid_parameters", allowed_offices: ["0001", "0003", "0005", "0006", "0007", "0008"] }, 400);
    const requestedUf = normalizeUf(url.searchParams.get("uf"));
    const ufs = requestedUf && requestedUf !== "br"
      ? (VALID_UFS.has(requestedUf) && requestedUf !== "br" ? [requestedUf] : null)
      : Object.keys(UF_NAMES);
    if (!ufs) return json({ error: "invalid_uf", message: "Informe uma UF válida ou omita uf para consultar os estados." }, 400);
    const states = await runWithConcurrency(ufs, 3, uf => mapStateResult({ ambiente, uf, cargo, election }));
    const available = states.filter(item => item.status === "connected");
    const ranking = [...available].sort((a, b) => b.sections_counted_percent - a.sections_counted_percent || b.sections_counted - a.sections_counted);
    return json({
      status: available.length ? "partial_or_complete" : "no_results",
      source: "TSE",
      environment: ambiente,
      phase: ambiente === "oficial" ? "oficial" : "simulado",
      office_code: cargo,
      election_code: election,
      states_requested: states.length,
      states_available: available.length,
      states_unavailable: states.length - available.length,
      ranking_basis: "sections_counted_percent_desc",
      ranking,
      states,
      note: ambiente === "oficial" ? "Dados consultados no ambiente oficial do TSE. Estados sem arquivo disponível são informados como unavailable; não são tratados como 0% de apuração." : "Dados de simulação do TSE. Não representam resultados reais."
    });
  }

  if (path === "/results") {
    const ambiente = (url.searchParams.get("ambiente") || "simulado").toLowerCase();
    const uf = normalizeUf(url.searchParams.get("uf"));
    const cargo = normalizeOffice(url.searchParams.get("cargo"));
    const election = normalizeElection(url.searchParams.get("eleicao"));

    if (!["oficial", "simulado"].includes(ambiente)) {
      return json({ error: "invalid_environment", allowed: ["oficial", "simulado"] }, 400);
    }
    if (!VALID_UFS.has(uf)) return json({ error: "invalid_uf", message: "Informe a sigla de uma UF brasileira, por exemplo sp." }, 400);
    if (!cargo) return json({ error: "invalid_cargo", allowed_examples: ["0001", "0003", "0005", "0006", "0007", "0008"] }, 400);
    if (!election) return json({ error: "invalid_eleicao", message: "Informe o código da eleição retornado pelo EA11, por exemplo 21270." }, 400);

    const cycle = ambiente === "simulado" ? "simulado2026" : "ele2026";
    const host = ambiente === "simulado" ? "https://resultados-sim.tse.jus.br" : "https://resultados.tse.jus.br";
    // A documentação do TSE coloca o ciclo eleitoral (ex.: ele2026) e, em seguida,
    // o código numérico da eleição. Não repetir o ciclo antes do código.
    // O diretório usa o código sem zeros à esquerda; o nome do arquivo usa seis dígitos.
    // Use a UF solicitada para que o mapa possa mostrar resultados estaduais.
    // Informe uf=br quando quiser o consolidado nacional.
    const scope = uf;
    const fileName = `${scope}-c${cargo}-e${election}-u.json`;
    const sourceUrl = `${host}/${ambiente}/${cycle}/${Number(election)}/dados/${scope}/${fileName}`;

    try {
      const result = await fetchJsonOnce(`result:${ambiente}:${uf}:${cargo}:${election}`, sourceUrl);
      if (!result.ok) {
        return json({
          status: "result_unavailable",
          source: "TSE",
          environment: ambiente,
          uf: scope.toUpperCase(),
          office_code: cargo,
          election_code: election,
          attempted_url: sourceUrl,
          http_status: result.status,
          message: result.status === 404
            ? "O arquivo unificado não foi encontrado neste caminho. Nenhuma URL alternativa foi tentada. Confirme o código da eleição e o arquivo publicado pelo TSE."
            : "Não foi possível obter o arquivo de resultados. Nenhuma repetição automática foi feita."
        }, 502);
      }
      const common = {
        status: "connected", source: "TSE", environment: ambiente,
        phase: result.data?.f === "s" ? "simulado" : result.data?.f === "o" ? "oficial" : "desconhecida",
        uf: scope.toUpperCase(), office_code: cargo, election_code: election,
        result_file: fileName, result_url: sourceUrl, retrieved_at: new Date().toISOString(), cached: result.cached
      };
      if ((url.searchParams.get("formato") || "").toLowerCase() === "resumo") {
        return json({ ...common, data: summarizeResults(result.data) });
      }
      return json({ ...common, data: result.data });
    } catch (error) {
      return json({
        status: "result_unavailable",
        source: "TSE",
        environment: ambiente,
        attempted_url: sourceUrl,
        message: error?.name === "TimeoutError"
          ? "O TSE não respondeu dentro de 8 segundos. Não houve repetição automática."
          : "Falha ao consultar ou interpretar o arquivo de resultados. Não houve repetição automática."
      }, 502);
    }
  }

  if (path === "/tse-config" || path === "/elections") {
    const ambiente = (url.searchParams.get("ambiente") || "oficial").toLowerCase();
    if (!["oficial", "simulado"].includes(ambiente)) {
      return json({ error: "invalid_environment", allowed: ["oficial", "simulado"] }, 400);
    }

    // O simulado publica a configuração sob /simulado/simulado2026/comum/.
    // A configuração oficial fica em /oficial/comum/. Não fazer tentativas
    // alternativas automáticas para evitar 404 repetidos e bloqueio do TSE.
    const cycle = ambiente === "simulado" ? "simulado2026" : "ele2026";
    const host = ambiente === "simulado"
      ? "https://resultados-sim.tse.jus.br"
      : "https://resultados.tse.jus.br";
    const sourceUrl = ambiente === "simulado"
      ? `${host}/${ambiente}/${cycle}/comum/config/ele-c.json`
      : `${host}/${ambiente}/comum/config/ele-c.json`;

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

  return json({ error: "not_found", available_endpoints: ["/api/health", "/api/tse-config", "/api/elections", "/api/results", "/api/results?formato=resumo", "/api/map"] }, 404);
};

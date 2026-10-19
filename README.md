# Portal de Apuração Eleitoral — versão Netlify

Esta é uma estrutura inicial adaptada para hospedagem no Netlify. Ela não inclui ainda um coletor funcional do TSE nem resultados eleitorais reais.

## Publicar

1. Extraia esta pasta e envie o conteúdo para um repositório Git (GitHub, GitLab ou Bitbucket).
2. No Netlify, escolha **Add new site → Import an existing project** e conecte o repositório.
3. Configure:
   - Build command: deixar vazio
   - Publish directory: `.`
   - Functions directory: `netlify/functions` (já indicado no `netlify.toml`)
4. Faça o deploy.
5. Teste `https://SEU-SITE.netlify.app/api/health`.

## Arquitetura de produção recomendada

- Frontend estático: Netlify.
- API leve: Netlify Functions.
- Banco persistente: PostgreSQL gerenciado, por exemplo Supabase, com credenciais somente no ambiente do servidor.
- Coletor de resultados: função agendada ou processo de ingestão externo confiável, conforme duração/frequência necessárias e limites do plano Netlify.
- Fonte: ambiente e arquivos oficiais de divulgação do TSE, respeitando documentação, limites de acesso, validação de integridade/assinaturas e a frequência oficial de publicação.

Não exponha credenciais do banco, tokens ou chaves privadas no frontend. O navegador deve chamar a API do próprio portal, não consultar repetidamente a origem do TSE por visitante.

## Estado atual

`/api/health` é apenas uma verificação de funcionamento. Outros endpoints retornam `501` até a implementação do coletor, modelo de dados e integração com os resultados oficiais. Não usar esta versão para publicar resultados reais.

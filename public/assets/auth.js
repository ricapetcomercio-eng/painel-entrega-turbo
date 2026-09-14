// public/assets/auth.js
// Gate de sessão compartilhado pelas páginas administrativas (Dashboard,
// Ponto, Estoque). Mesmo login que já existia no Ponto (funcionário + PIN,
// só quem tem a flag admin no banco entra) — este script só decide se a
// página atual pode ficar aberta ou se manda pra tela de login.
//
// tv.html NÃO inclui este script de propósito: a TV do galpão continua sem
// login, exatamente como antes (protegida, no máximo, pelo DASHBOARD_TOKEN
// opcional do link fixo).
(function () {
  const CHAVE_SESSAO = 'ricapet_sessao';

  // sessionStorage (não localStorage) de propósito: a sessão dura só
  // enquanto a aba/janela do navegador estiver aberta -- fechou, precisa
  // logar de novo. Evita ficar logado indefinidamente num computador
  // compartilhado (ex.: o link fixo na barra de tarefas do galpão).
  function lerSessao() {
    try { return JSON.parse(sessionStorage.getItem(CHAVE_SESSAO) || 'null'); } catch { return null; }
  }

  const sessao = lerSessao();
  if (!sessao || !sessao.token) {
    const volta = encodeURIComponent(location.pathname + location.search);
    location.href = '/login.html?redirect=' + volta;
  }

  function sair() {
    sessionStorage.removeItem(CHAVE_SESSAO);
    location.href = '/login.html';
  }

  window.RicapetAuth = { CHAVE_SESSAO, sessao, lerSessao, sair };
})();

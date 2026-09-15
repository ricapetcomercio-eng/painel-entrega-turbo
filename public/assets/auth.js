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

  // Controle de acesso por página (tela Acessos, só super_admin) — a lista
  // de páginas liberadas vem prontinha do login (ponto-login), pra não
  // precisar de outra chamada só pra decidir o que mostrar na barra
  // lateral. super_admin sempre tem tudo, mesmo sem estar na lista.
  function possuiAcesso(pagina) {
    if (!sessao) return false;
    if (sessao.super_admin) return true;
    return Array.isArray(sessao.paginas) && sessao.paginas.includes(pagina);
  }

  // Esconde da barra lateral (aqui e em toda página que usa o mesmo
  // data-menu-key) os links de página que este usuário não tem liberada.
  // Cosmético só — quem realmente barra é a checagem no backend (ver
  // lib/pontoAuth.js); isso aqui só evita mostrar um link que vai dar 403.
  function aplicarVisibilidadeMenu() {
    document.querySelectorAll('[data-menu-key]').forEach((el) => {
      const pagina = el.dataset.menuKey;
      if (pagina === 'acessos') { el.style.display = sessao && sessao.super_admin ? '' : 'none'; return; }
      if (!possuiAcesso(pagina)) el.style.display = 'none';
    });
  }

  // Overlay de "sem acesso" pra quando alguém abre a URL de uma página
  // direto (sem passar pelo link já escondido) e o backend recusa com 403
  // por falta de permissão de página. Sem isso a tela ficava em branco ou
  // com erro cru — mesma armadilha silenciosa já documentada no CLAUDE.md
  // pro DASHBOARD_TOKEN mal configurado.
  function mostrarAcessoNegado(mensagem) {
    if (document.getElementById('overlayAcessoNegado')) return;
    const overlay = document.createElement('div');
    overlay.id = 'overlayAcessoNegado';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(20,16,40,.85);'
      + 'display:flex;align-items:center;justify-content:center;padding:24px;';
    overlay.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:420px;padding:28px 24px;'
      + 'text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.25);font-family:inherit;">'
      + '<div style="font-size:34px;margin-bottom:8px;">🔒</div>'
      + '<div style="font-size:16px;font-weight:600;color:#1f2430;margin-bottom:6px;">Acesso restrito</div>'
      + '<div style="font-size:13px;color:#5b6270;line-height:1.5;">' + (mensagem || 'Você não tem acesso a esta área. Peça liberação ao Ricardo.') + '</div>'
      + '<a href="/" style="display:inline-block;margin-top:16px;padding:8px 18px;border-radius:8px;'
      + 'background:#6C5DD3;color:#fff;text-decoration:none;font-size:13px;font-weight:600;">Voltar ao início</a></div>';
    document.body.appendChild(overlay);
  }

  window.RicapetAuth = { CHAVE_SESSAO, sessao, lerSessao, sair, possuiAcesso, aplicarVisibilidadeMenu, mostrarAcessoNegado };
})();

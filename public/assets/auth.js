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

  // Mesma duração de lib/pontoAuth.js (DURACAO_INATIVIDADE_MS) -- duplicada
  // aqui porque este arquivo é servido cru pro navegador (sem build step
  // pra compartilhar uma constante com o backend). Se mudar um lado, mudar
  // o outro. A sessão expira por INATIVIDADE (5min sem clique/tecla/scroll/
  // mousemove), não por um prazo fixo desde o login -- ver a renovação
  // mais abaixo. Isso aqui é só uma conferência client-side pra reagir na
  // hora (sem esperar uma chamada de API falhar com 401) -- quem realmente
  // barra é o backend (obterAdminSessao), mesmo se essa conta aqui divergir.
  const DURACAO_INATIVIDADE_MS = 5 * 60 * 1000;
  const INTERVALO_RENOVAR_MS = 60 * 1000; // renova o token nesse ritmo, só enquanto há atividade
  const INTERVALO_CHECAR_MS = 15 * 1000; // confere expiração nesse ritmo, mesmo sem clique nenhum
  // Mesmo valor de login.html (PONTO_PUBLIC_SECRET) -- gate fraco,
  // pré-compartilhado, pra reautenticar (ponto-login) sem sair da página
  // quando a sessão expira por inatividade. Quem realmente autoriza é o
  // PIN do funcionário.
  const PONTO_PUBLIC_SECRET = 'f3BqH1JDY6dWb-n4aEhSVcZJrSPvU0Rf';

  // Lê o "miolo" do token (id/nome/emissao) sem checar assinatura -- não
  // precisa: é só pra decidir se vale a pena mandar o navegador pro login
  // (ou mostrar a reautenticação) antes mesmo de tentar usar a página.
  // Token de verdade só é validado no servidor.
  function decodificarToken(token) {
    try {
      const payload = String(token || '').split('.')[0];
      return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    } catch { return null; }
  }

  function tokenExpirado(token) {
    const dados = decodificarToken(token);
    return !dados || !dados.emissao || (Date.now() - dados.emissao) > DURACAO_INATIVIDADE_MS;
  }

  // Log de segurança (logout/sessão expirada) -- fire-and-forget, nunca
  // trava nem atrasa a ação real (sair/expirar). sendBeacon é feito
  // exatamente pra isso: sobrevive à navegação que acontece logo em
  // seguida (um fetch comum, sem keepalive, pode ser cancelado pelo
  // navegador assim que a página começa a descarregar).
  function registrarEventoSessao(evento, tokenParaLog) {
    try {
      const dados = decodificarToken(tokenParaLog);
      const corpo = JSON.stringify({
        evento,
        funcionario_id: dados && dados.id,
        nome: dados && dados.nome,
        pagina: location.pathname,
      });
      const url = '/api/debug?tipo=log-evento-sessao&secret=' + encodeURIComponent(PONTO_PUBLIC_SECRET);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([corpo], { type: 'application/json' }));
      } else {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo, keepalive: true }).catch(() => {});
      }
    } catch (e) { /* log de auditoria nunca deve travar nada */ }
  }

  let sessao = lerSessao();
  if (sessao && sessao.token && tokenExpirado(sessao.token)) {
    sessionStorage.removeItem(CHAVE_SESSAO);
    sessao = null;
  }
  if (!sessao || !sessao.token) {
    const volta = encodeURIComponent(location.pathname + location.search);
    location.href = '/login.html?redirect=' + volta;
  }

  function sair() {
    if (sessao && sessao.token) registrarEventoSessao('logout', sessao.token);
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

  // ---- Daqui pra baixo só roda se a página passou na checagem acima com
  // sessão válida (senão já foi redirecionada pro login e não há por que
  // gastar ciclo com timers/listeners numa página que está saindo). ----
  if (!sessao) return;

  // Qualquer sinal de uso real da página conta como atividade -- não
  // precisa throttle: são só atribuições de número, custo desprezível
  // mesmo em 'mousemove'/'scroll' (passive, sem side effect pesado).
  let ultimaAtividade = Date.now();
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach((evento) => {
    window.addEventListener(evento, () => { ultimaAtividade = Date.now(); }, { passive: true, capture: true });
  });

  let renovando = false;
  let ultimaRenovacao = Date.now();
  // Marca a última `ultimaAtividade` que já "gastamos" numa renovação --
  // começa IGUAL a ultimaAtividade (não zero) de propósito: só o load da
  // página, sem nenhum toque real depois, não deve contar como "atividade
  // nova" e disparar nem uma renovação sequer -- sem essa igualdade
  // inicial, uma página aberta e nunca tocada ainda ganhava uma renovação
  // "de graça" no primeiro ciclo, empurrando o `emissao` do token pra
  // frente e adiando a expiração real além dos 5min pedidos (bug
  // encontrado testando o limite exato). Só renova quando
  // `ultimaAtividade` avança de verdade (houve clique/tecla/scroll novo).
  let ultimaAtividadeConsiderada = ultimaAtividade;
  async function renovarToken() {
    if (renovando) return;
    renovando = true;
    try {
      const resp = await fetch('/api/debug?tipo=ponto-renovar-sessao&sessao=' + encodeURIComponent(sessao.token));
      if (resp.status === 401) { mostrarReautenticacao(); return; }
      const dados = await resp.json().catch(() => ({}));
      if (dados.ok && dados.token) {
        // Muta o MESMO objeto (não substitui a referência) -- páginas que
        // já fizeram `const s = window.RicapetAuth.sessao` (ex.:
        // estoque.html) continuam enxergando o token renovado nas
        // próximas chamadas, sem precisar reler window.RicapetAuth.sessao.
        sessao.token = dados.token;
        sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify(sessao));
        ultimaRenovacao = Date.now();
      }
    } catch (e) { /* rede falhou -- tenta de novo no próximo ciclo, não desloga por causa disso */ }
    finally { renovando = false; }
  }

  let overlayAtivo = false;
  function checarInatividade() {
    if (overlayAtivo) return;
    if (tokenExpirado(sessao.token)) { mostrarReautenticacao(); return; }
    // Só renova quando há atividade GENUINAMENTE NOVA desde a última vez
    // que renovamos por causa de atividade (não só "dentro da janela de
    // inatividade", que ficaria vencendo desde o load da página mesmo sem
    // nenhum toque real -- ver comentário em ultimaAtividadeConsiderada).
    // INTERVALO_RENOVAR_MS (mais espaçado que a checagem de 15s) evita
    // bater nessa rota a cada tick só de olhar a tela.
    const houveAtividadeNova = ultimaAtividade > ultimaAtividadeConsiderada;
    const jaPodeRenovarDeNovo = Date.now() - ultimaRenovacao >= INTERVALO_RENOVAR_MS;
    if (houveAtividadeNova && jaPodeRenovarDeNovo) {
      ultimaAtividadeConsiderada = ultimaAtividade;
      renovarToken();
    }
  }
  setInterval(checarInatividade, INTERVALO_CHECAR_MS);

  // Voltar pelo navegador (bfcache) pode reexibir a página sem recarregar
  // nem reexecutar este script -- `pageshow` com `persisted:true` cobre
  // esse caso, reforçando a mesma checagem do carregamento inicial.
  window.addEventListener('pageshow', (ev) => {
    if (ev.persisted && tokenExpirado(sessao.token)) {
      const volta = encodeURIComponent(location.pathname + location.search);
      location.href = '/login.html?redirect=' + volta;
    }
  });

  // Sessão expirou com a página ainda aberta (por inatividade real) --
  // diferente do caso "sem sessão nenhuma" do topo do arquivo (que manda
  // pro /login.html), aqui a página já está aberta e em uso, então pede a
  // senha de novo SEM navegar pra outro lugar (preserva filtros, abas
  // abertas etc.) -- exatamente como pedido: volta pra onde estava depois
  // de digitar a senha, porque nunca saiu de lá.
  function mostrarReautenticacao() {
    if (overlayAtivo) return;
    overlayAtivo = true;
    registrarEventoSessao('sessao_expirada', sessao.token);
    const dadosToken = decodificarToken(sessao.token);
    const overlay = document.createElement('div');
    overlay.id = 'overlaySessaoExpirada';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(15,23,32,.85);'
      + 'display:flex;align-items:center;justify-content:center;padding:24px;';
    overlay.innerHTML = '<form id="formReautenticar" style="background:#fff;border-radius:14px;max-width:340px;width:100%;'
      + 'padding:28px 24px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.25);font-family:inherit;box-sizing:border-box;">'
      + '<div style="font-size:34px;margin-bottom:8px;">🔒</div>'
      + '<div style="font-size:16px;font-weight:700;color:#1f2430;margin-bottom:6px;">Sessão expirada</div>'
      + '<div style="font-size:13px;color:#5b6270;line-height:1.5;margin-bottom:16px;">Por segurança, digite sua senha novamente'
      + (dadosToken && dadosToken.nome ? ', ' + escaparHtml(dadosToken.nome) : '') + ', para continuar.</div>'
      + '<input type="password" id="inPinReautenticar" inputmode="numeric" maxlength="8" required autocomplete="new-password" '
      + 'data-lpignore="true" data-1p-ignore data-bwignore style="width:100%;height:44px;border-radius:10px;border:1px solid #d8dbe3;'
      + 'text-align:center;font-size:18px;letter-spacing:8px;box-sizing:border-box;margin-bottom:10px;">'
      + '<button type="submit" style="width:100%;height:44px;border:none;border-radius:10px;background:#00A9C7;color:#fff;'
      + 'font-weight:700;font-size:15px;cursor:pointer;">Entrar</button>'
      + '<p id="erroReautenticar" style="color:#DC2626;font-size:13px;min-height:1.2em;margin:10px 0 0;"></p>'
      + '<a href="#" id="linkSairReautenticar" style="display:inline-block;margin-top:10px;font-size:12px;color:#8a90a2;">Não é você? Sair</a></form>';
    document.body.appendChild(overlay);
    const inPin = document.getElementById('inPinReautenticar');
    inPin.focus();
    document.getElementById('linkSairReautenticar').addEventListener('click', (ev) => { ev.preventDefault(); sair(); });
    document.getElementById('formReautenticar').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const erro = document.getElementById('erroReautenticar');
      erro.textContent = '';
      const botao = ev.target.querySelector('button[type="submit"]');
      botao.disabled = true;
      try {
        const resp = await fetch('/api/debug?tipo=ponto-login&secret=' + encodeURIComponent(PONTO_PUBLIC_SECRET), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ funcionario_id: dadosToken && dadosToken.id, pin: inPin.value }),
        });
        const dados = await resp.json().catch(() => ({}));
        if (!resp.ok || dados.ok === false) throw new Error(dados.error || 'Senha incorreta.');
        if (!dados.admin) throw new Error('Seu usuário não tem acesso a este painel.');
        sessao.token = dados.token;
        sessao.nome = dados.nome;
        sessao.super_admin = !!dados.super_admin;
        sessao.paginas = dados.paginas || [];
        sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify(sessao));
        ultimaAtividade = Date.now();
        ultimaAtividadeConsiderada = ultimaAtividade;
        ultimaRenovacao = Date.now();
        overlay.remove();
        overlayAtivo = false;
      } catch (err) {
        erro.textContent = err.message;
        botao.disabled = false;
        inPin.value = '';
        inPin.focus();
      }
    });
  }

  function escaparHtml(texto) {
    return String(texto).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();

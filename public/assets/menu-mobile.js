// Ricapet — menu lateral recolhível no celular.
// Abaixo de 900px a sidebar vira uma faixa no topo da página (CSS em
// tokens-admin.css). Com todos os links abertos, essa faixa ocupava ~1/3 da
// tela antes do conteúdo. Este script põe um botão "☰ Menu" no começo da
// sidebar e deixa ela recolhida por padrão: só o botão (com o nome da tela
// atual) aparece até a pessoa tocar nele. No computador o botão fica oculto
// e nada muda. Sem JavaScript, a sidebar continua como antes (toda aberta).
(function () {
  function nomeTelaAtual(nav) {
    var ativo = nav.querySelector('.sidebar-link.ativo');
    return ativo ? ativo.textContent.trim() : '';
  }

  function iniciar() {
    var nav = document.querySelector('.sidebar');
    if (!nav || nav.querySelector('.sidebar-menu-toggle')) return;
    if (!nav.id) nav.id = 'sidebar-principal';

    var botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'sidebar-menu-toggle';
    botao.setAttribute('aria-controls', nav.id);
    botao.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' +
      '<span class="sidebar-menu-toggle-rotulo">Menu</span>' +
      '<span class="sidebar-menu-toggle-atual"></span>';
    nav.insertBefore(botao, nav.firstChild);

    function atualizar(aberto) {
      nav.classList.toggle('menu-recolhido', !aberto);
      botao.setAttribute('aria-expanded', aberto ? 'true' : 'false');
      botao.setAttribute('aria-label', aberto ? 'Fechar menu' : 'Abrir menu');
      var atual = nomeTelaAtual(nav);
      botao.querySelector('.sidebar-menu-toggle-atual').textContent = atual ? '· ' + atual : '';
    }

    botao.addEventListener('click', function () {
      atualizar(nav.classList.contains('menu-recolhido'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !nav.classList.contains('menu-recolhido')) {
        atualizar(false);
        botao.focus();
      }
    });

    atualizar(false);
    // Algumas telas (ex.: Dashboard com ?painel=) marcam o link ativo depois
    // de carregar — atualiza o nome mostrado no botão quando isso acontecer.
    window.addEventListener('load', function () {
      atualizar(!nav.classList.contains('menu-recolhido'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();

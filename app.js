// app.js
//
// Логика веб-интерфейса учёта коллекции MTG.
// Использует Supabase JS-клиент напрямую из браузера (через anon key).

// ---------- Инициализация клиента ----------
if (!SUPABASE_URL.startsWith("https://") || SUPABASE_ANON_KEY.includes("ВАШ")) {
  document.body.innerHTML = `
    <div class="config-warning">
      <h3 style="color:#d3603f; margin-bottom:0.6rem;">Не настроен config.js</h3>
      <p>Открой файл <code>config.js</code> и впиши туда свой <code>SUPABASE_URL</code>
      и <code>SUPABASE_ANON_KEY</code> (anon public, не service_role) из
      Project Settings → API в Supabase Dashboard.</p>
    </div>`;
  throw new Error("config.js не настроен");
}

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- Утилиты ----------
function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.style.borderColor = isError ? "var(--mana-r)" : "var(--gold)";
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2800);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------- Переключение вкладок ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`view-${btn.dataset.view}`).classList.add("active");
    if (btn.dataset.view === "collection") loadCollection();
  });
});

// =========================================================
// ВКЛАДКА: КАТАЛОГ
// =========================================================

const PAGE_SIZE = 24;
let catalogPage = 0;
let activeColors = new Set();
let pendingCardForAdd = null;

const catalogGrid = document.getElementById("catalog-grid");
const catalogStatus = document.getElementById("catalog-status");
const catalogPagination = document.getElementById("catalog-pagination");

document.getElementById("catalog-search").addEventListener(
  "input",
  debounce(() => {
    catalogPage = 0;
    runCatalogSearch();
  }, 400)
);

document.getElementById("catalog-rarity").addEventListener("change", () => {
  catalogPage = 0;
  runCatalogSearch();
});

document.querySelectorAll(".mana-dot").forEach((dot) => {
  dot.addEventListener("click", () => {
    const color = dot.dataset.color;
    if (activeColors.has(color)) {
      activeColors.delete(color);
      dot.classList.remove("active");
    } else {
      activeColors.add(color);
      dot.classList.add("active");
    }
    catalogPage = 0;
    runCatalogSearch();
  });
});

document.getElementById("catalog-reset").addEventListener("click", () => {
  document.getElementById("catalog-search").value = "";
  document.getElementById("catalog-rarity").value = "";
  activeColors.clear();
  document.querySelectorAll(".mana-dot").forEach((d) => d.classList.remove("active"));
  catalogPage = 0;
  catalogGrid.innerHTML = "";
  catalogPagination.style.display = "none";
  catalogStatus.textContent = "Введите название карты, чтобы начать поиск.";
});

document.getElementById("catalog-prev").addEventListener("click", () => {
  if (catalogPage > 0) {
    catalogPage--;
    runCatalogSearch();
  }
});
document.getElementById("catalog-next").addEventListener("click", () => {
  catalogPage++;
  runCatalogSearch();
});

async function runCatalogSearch() {
  const term = document.getElementById("catalog-search").value.trim();
  const rarity = document.getElementById("catalog-rarity").value;

  if (!term && activeColors.size === 0 && !rarity) {
    catalogGrid.innerHTML = "";
    catalogPagination.style.display = "none";
    catalogStatus.textContent = "Введите название карты, чтобы начать поиск.";
    return;
  }

  catalogStatus.textContent = "Ищу карты…";

  let query = db
    .from("cards")
    .select("id, name, set_code, rarity, mana_cost, type_line, colors, image_uris", { count: "exact" });

  if (term) query = query.ilike("name", `%${term}%`);
  if (rarity) query = query.eq("rarity", rarity);
  if (activeColors.size > 0) query = query.contains("colors", Array.from(activeColors));

  const from = catalogPage * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  query = query.order("name").range(from, to);

  const { data, error, count } = await query;

  if (error) {
    catalogStatus.textContent = "Ошибка поиска: " + error.message;
    return;
  }

  if (data.length === 0) {
    catalogGrid.innerHTML = `<div class="empty-state"><span class="display">Ничего не найдено</span>Попробуй изменить запрос или фильтры.</div>`;
    catalogPagination.style.display = "none";
    catalogStatus.textContent = "";
    return;
  }

  catalogStatus.textContent = `Найдено карт: ${count ?? data.length}`;
  renderCatalogGrid(data);

  catalogPagination.style.display = "flex";
  document.getElementById("catalog-prev").disabled = catalogPage === 0;
  document.getElementById("catalog-next").disabled = to + 1 >= (count ?? 0);
}

function renderCatalogGrid(cards) {
  catalogGrid.innerHTML = cards
    .map((card) => {
      const img = card.image_uris?.normal || card.image_uris?.small;
      const imgHtml = img
        ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(card.name)}" loading="lazy">`
        : `<div class="no-image">${escapeHtml(card.name)}</div>`;
      return `
        <div class="card-tile">
          ${imgHtml}
          <div class="card-tile-body">
            <div class="card-tile-name">${escapeHtml(card.name)}</div>
            <div class="card-tile-meta">${escapeHtml(card.set_code?.toUpperCase() || "")} · ${escapeHtml(card.rarity || "")}</div>
            <div class="card-tile-actions">
              <button class="btn small add-to-collection-btn" data-id="${card.id}" data-name="${escapeHtml(card.name)}">+ В коллекцию</button>
            </div>
          </div>
        </div>`;
    })
    .join("");

  catalogGrid.querySelectorAll(".add-to-collection-btn").forEach((btn) => {
    btn.addEventListener("click", () => openAddModal(btn.dataset.id, btn.dataset.name));
  });
}

// =========================================================
// МОДАЛКА: добавить карту в коллекцию
// =========================================================

const addModal = document.getElementById("add-modal");

function openAddModal(cardId, cardName) {
  pendingCardForAdd = cardId;
  document.getElementById("add-modal-title").textContent = `Добавить «${cardName}»`;
  document.getElementById("add-quantity").value = 1;
  document.getElementById("add-finish").value = "nonfoil";
  document.getElementById("add-condition").value = "NM";
  document.getElementById("add-price").value = "";
  document.getElementById("add-notes").value = "";
  addModal.classList.add("active");
}

document.getElementById("add-cancel").addEventListener("click", () => {
  addModal.classList.remove("active");
  pendingCardForAdd = null;
});

addModal.addEventListener("click", (e) => {
  if (e.target === addModal) {
    addModal.classList.remove("active");
    pendingCardForAdd = null;
  }
});

document.getElementById("add-confirm").addEventListener("click", async () => {
  if (!pendingCardForAdd) return;

  const payload = {
    card_id: pendingCardForAdd,
    quantity: parseInt(document.getElementById("add-quantity").value, 10) || 1,
    finish: document.getElementById("add-finish").value,
    condition: document.getElementById("add-condition").value,
    purchase_price: document.getElementById("add-price").value
      ? parseFloat(document.getElementById("add-price").value)
      : null,
    notes: document.getElementById("add-notes").value || null,
  };

  const { error } = await db.from("collection_items").insert(payload);

  if (error) {
    showToast("Не удалось добавить: " + error.message, true);
  } else {
    showToast("Карта добавлена в коллекцию");
    addModal.classList.remove("active");
    pendingCardForAdd = null;
  }
});

// =========================================================
// ВКЛАДКА: МОЯ КОЛЛЕКЦИЯ
// =========================================================

document.getElementById("collection-refresh").addEventListener("click", loadCollection);
document.getElementById("collection-search").addEventListener(
  "input",
  debounce(() => loadCollection(), 350)
);

async function loadCollection() {
  const term = document.getElementById("collection-search").value.trim();

  let query = db.from("collection_with_details").select("*").order("name");
  if (term) query = query.ilike("name", `%${term}%`);

  const { data, error } = await query;

  if (error) {
    document.getElementById("collection-table-wrap").innerHTML = `<div class="empty-state">Ошибка загрузки: ${escapeHtml(error.message)}</div>`;
    return;
  }

  renderSummary(data);
  renderCollectionTable(data);
}

function renderSummary(items) {
  const totalCards = items.reduce((sum, i) => sum + i.quantity, 0);
  const uniqueCards = items.length;
  const totalValue = items.reduce((sum, i) => {
    const price = i.prices?.usd ? parseFloat(i.prices.usd) : 0;
    return sum + price * i.quantity;
  }, 0);

  document.getElementById("collection-summary").innerHTML = `
    <div class="summary-stat"><span class="num">${totalCards}</span><span class="label">Всего экземпляров</span></div>
    <div class="summary-stat"><span class="num">${uniqueCards}</span><span class="label">Уникальных карт</span></div>
    <div class="summary-stat"><span class="num">$${totalValue.toFixed(2)}</span><span class="label">Примерная стоимость (USD)</span></div>
  `;
}

function renderCollectionTable(items) {
  const wrap = document.getElementById("collection-table-wrap");

  if (items.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><span class="display">Коллекция пуста</span>Перейди в «Каталог» и добавь первую карту.</div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Карта</th>
          <th>Сет</th>
          <th>Кол-во</th>
          <th>Исполнение</th>
          <th>Состояние</th>
          <th>Заметки</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${items.map(rowHtml).join("")}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll(".qty-input").forEach((input) => {
    input.addEventListener("change", () => updateItem(input.dataset.id, { quantity: parseInt(input.value, 10) || 0 }));
  });
  wrap.querySelectorAll(".condition-select").forEach((sel) => {
    sel.addEventListener("change", () => updateItem(sel.dataset.id, { condition: sel.value }));
  });
  wrap.querySelectorAll(".finish-select").forEach((sel) => {
    sel.addEventListener("change", () => updateItem(sel.dataset.id, { finish: sel.value }));
  });
  wrap.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteItem(btn.dataset.id));
  });
}

function rowHtml(item) {
  return `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td><span class="pill">${escapeHtml((item.set_code || "").toUpperCase())}</span></td>
      <td><input type="number" class="qty-input" data-id="${item.id}" value="${item.quantity}" min="0"></td>
      <td>
        <select class="finish-select" data-id="${item.id}">
          <option value="nonfoil" ${item.finish === "nonfoil" ? "selected" : ""}>Обычная</option>
          <option value="foil" ${item.finish === "foil" ? "selected" : ""}>Фойл</option>
          <option value="etched" ${item.finish === "etched" ? "selected" : ""}>Etched</option>
        </select>
      </td>
      <td>
        <select class="condition-select" data-id="${item.id}">
          ${["NM", "LP", "MP", "HP", "DMG"].map((c) => `<option value="${c}" ${item.condition === c ? "selected" : ""}>${c}</option>`).join("")}
        </select>
      </td>
      <td>${escapeHtml(item.notes || "—")}</td>
      <td><button class="btn danger small delete-btn" data-id="${item.id}">Удалить</button></td>
    </tr>
  `;
}

async function updateItem(id, fields) {
  const { error } = await db.from("collection_items").update(fields).eq("id", id);
  if (error) {
    showToast("Не удалось сохранить: " + error.message, true);
  } else {
    showToast("Сохранено");
    loadCollection();
  }
}

async function deleteItem(id) {
  if (!confirm("Удалить эту запись из коллекции?")) return;
  const { error } = await db.from("collection_items").delete().eq("id", id);
  if (error) {
    showToast("Не удалось удалить: " + error.message, true);
  } else {
    showToast("Удалено из коллекции");
    loadCollection();
  }
}

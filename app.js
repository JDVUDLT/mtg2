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

// Подгружаем коробки сразу, чтобы выпадающий список в модалке добавления
// был готов, даже если пользователь не заходил на вкладку "Моя коллекция".
loadBoxes();

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
    if (btn.dataset.view === "collection") {
      loadBoxes();
      loadCollection();
    }
  });
});

// =========================================================
// КОРОБКИ: общее состояние и загрузка
// =========================================================

let boxesCache = []; // [{id, name, description, card_count}]

async function loadBoxes() {
  const { data: boxes, error } = await db.from("boxes").select("id, name, description").order("name");
  if (error) {
    showToast("Не удалось загрузить коробки: " + error.message, true);
    return;
  }

  // считаем сколько экземпляров карт лежит в каждой коробке
  const { data: assignments } = await db.from("box_assignments").select("box_id, quantity");
  const countByBox = new Map();
  (assignments || []).forEach((a) => {
    countByBox.set(a.box_id, (countByBox.get(a.box_id) || 0) + a.quantity);
  });

  boxesCache = boxes.map((b) => ({ ...b, card_count: countByBox.get(b.id) || 0 }));

  renderBoxesGrid();
  fillBoxSelects();
}

function renderBoxesGrid() {
  const grid = document.getElementById("boxes-grid");
  if (boxesCache.length === 0) {
    grid.innerHTML = `<div class="boxes-empty">Коробок пока нет — создай первую, чтобы начать сортировать коллекцию.</div>`;
    return;
  }
  grid.innerHTML = boxesCache
    .map(
      (b) => `
      <div class="box-tile">
        <div class="box-name">${escapeHtml(b.name)}</div>
        <div class="box-count">${b.card_count} экз.</div>
        ${b.description ? `<div class="box-desc">${escapeHtml(b.description)}</div>` : ""}
      </div>`
    )
    .join("");
}

// заполняет все select'ы с классом box-select (в модалке добавления и фильтре коллекции)
function fillBoxSelects() {
  const addBoxSelect = document.getElementById("add-box");
  addBoxSelect.innerHTML =
    `<option value="">Без коробки</option>` +
    boxesCache.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");

  const filterSelect = document.getElementById("collection-box-filter");
  filterSelect.innerHTML =
    `<option value="">Все коробки</option><option value="none">Без коробки</option>` +
    boxesCache.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");
}

// ---------- Создание новой коробки ----------
const createBoxModal = document.getElementById("create-box-modal");

document.getElementById("create-box-btn").addEventListener("click", () => {
  document.getElementById("box-name").value = "";
  document.getElementById("box-description").value = "";
  createBoxModal.classList.add("active");
});

document.getElementById("create-box-cancel").addEventListener("click", () => {
  createBoxModal.classList.remove("active");
});
createBoxModal.addEventListener("click", (e) => {
  if (e.target === createBoxModal) createBoxModal.classList.remove("active");
});

document.getElementById("create-box-confirm").addEventListener("click", async () => {
  const name = document.getElementById("box-name").value.trim();
  if (!name) {
    showToast("Введи название коробки", true);
    return;
  }
  const description = document.getElementById("box-description").value.trim() || null;

  const { error } = await db.from("boxes").insert({ name, description });
  if (error) {
    showToast("Не удалось создать коробку: " + error.message, true);
  } else {
    showToast("Коробка создана");
    createBoxModal.classList.remove("active");
    await loadBoxes();
  }
});

document.getElementById("collection-box-filter").addEventListener("change", loadCollection);

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
    .from("cards_light")
    .select("id, name, printed_name, set_code, rarity, mana_cost, type_line, colors, image_small, image_normal", { count: "exact" });

  if (term) query = query.or(`name.ilike.%${term}%,printed_name.ilike.%${term}%`);
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
      const img = card.image_normal || card.image_small;
      const displayName = card.printed_name || card.name;
      const imgHtml = img
        ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(displayName)}" loading="lazy">`
        : `<div class="no-image">${escapeHtml(displayName)}</div>`;
      return `
        <div class="card-tile">
          ${imgHtml}
          <div class="card-tile-body">
            <div class="card-tile-name">${escapeHtml(displayName)}</div>
            <div class="card-tile-meta">${escapeHtml(card.set_code?.toUpperCase() || "")} · ${escapeHtml(card.rarity || "")}</div>
            <div class="card-tile-actions">
              <button class="btn small add-to-collection-btn" data-id="${card.id}" data-name="${escapeHtml(displayName)}">+ В коллекцию</button>
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

  const quantity = parseInt(document.getElementById("add-quantity").value, 10) || 1;
  const boxId = document.getElementById("add-box").value || null;

  const payload = {
    card_id: pendingCardForAdd,
    quantity,
    finish: document.getElementById("add-finish").value,
    condition: document.getElementById("add-condition").value,
    purchase_price: document.getElementById("add-price").value
      ? parseFloat(document.getElementById("add-price").value)
      : null,
    notes: document.getElementById("add-notes").value || null,
  };

  const { data: inserted, error } = await db.from("collection_items").insert(payload).select("id").single();

  if (error) {
    showToast("Не удалось добавить: " + error.message, true);
    return;
  }

  // Если выбрана конкретная коробка — сразу распределяем туда все добавленные экземпляры
  if (boxId) {
    const { error: assignError } = await db
      .from("box_assignments")
      .insert({ collection_item_id: inserted.id, box_id: boxId, quantity });
    if (assignError) {
      showToast("Карта добавлена, но не удалось положить в коробку: " + assignError.message, true);
      addModal.classList.remove("active");
      pendingCardForAdd = null;
      return;
    }
  }

  showToast("Карта добавлена в коллекцию");
  addModal.classList.remove("active");
  pendingCardForAdd = null;
  loadBoxes(); // обновить счётчики карт в коробках
});

// =========================================================
// ВКЛАДКА: МОЯ КОЛЛЕКЦИЯ
// =========================================================

let currentCollectionItems = [];

document.getElementById("collection-refresh").addEventListener("click", loadCollection);
document.getElementById("collection-search").addEventListener(
  "input",
  debounce(() => loadCollection(), 350)
);

async function loadCollection() {
  const term = document.getElementById("collection-search").value.trim();
  const boxFilter = document.getElementById("collection-box-filter").value;

  let query = db.from("collection_with_boxes").select("*").order("name");
  if (term) query = query.or(`name.ilike.%${term}%,printed_name.ilike.%${term}%`);

  const { data, error } = await query;

  if (error) {
    document.getElementById("collection-table-wrap").innerHTML = `<div class="empty-state">Ошибка загрузки: ${escapeHtml(error.message)}</div>`;
    return;
  }

  // Группируем строки view по collection_item_id: одна запись коллекции может
  // встречаться несколько раз в данных — по разу на каждую коробку, в которую она разложена.
  const grouped = new Map();
  for (const row of data) {
    if (!grouped.has(row.collection_item_id)) {
      grouped.set(row.collection_item_id, {
        id: row.collection_item_id,
        name: row.name,
        printed_name: row.printed_name,
        set_code: row.set_code,
        quantity: row.total_quantity,
        finish: row.finish,
        condition: row.condition,
        notes: row.notes,
        prices: row.prices,
        quantity_unassigned: row.quantity_unassigned,
        boxAssignments: [], // [{box_id, box_name, quantity}]
      });
    }
    if (row.box_id) {
      grouped.get(row.collection_item_id).boxAssignments.push({
        box_id: row.box_id,
        box_name: row.box_name,
        quantity: row.quantity_in_box,
      });
    }
  }

  let items = Array.from(grouped.values());

  // Фильтр по коробке применяем уже на сгруппированных данных
  if (boxFilter === "none") {
    items = items.filter((i) => i.quantity_unassigned > 0 || i.boxAssignments.length === 0);
  } else if (boxFilter) {
    items = items.filter((i) => i.boxAssignments.some((a) => String(a.box_id) === boxFilter));
  }

  renderSummary(items);
  currentCollectionItems = items;
  renderCollectionTable(items);
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
          <th>Коробки</th>
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
  wrap.querySelectorAll(".manage-boxes-btn").forEach((btn) => {
    btn.addEventListener("click", () => openAssignModal(btn.dataset.id, currentCollectionItems));
  });
}

function rowHtml(item) {
  const boxPills = item.boxAssignments
    .map((a) => `<span class="box-pill">${escapeHtml(a.box_name)} ×${a.quantity}</span>`)
    .join("");
  const unassignedPill =
    item.quantity_unassigned > 0
      ? `<span class="box-pill unassigned">Без коробки ×${item.quantity_unassigned}</span>`
      : "";

  return `
    <tr>
      <td>${escapeHtml(item.printed_name || item.name)}</td>
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
      <td>
        ${boxPills}${unassignedPill}
        <div><button class="btn secondary small manage-boxes-btn" data-id="${item.id}">Разложить</button></div>
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
    loadBoxes();
  }
}

// =========================================================
// МОДАЛКА: разложить запись коллекции по коробкам
// =========================================================

const assignModal = document.getElementById("assign-box-modal");
let assigningItemId = null;
let assigningItemTotalQty = 0;

function openAssignModal(itemId, items) {
  const item = items.find((i) => String(i.id) === String(itemId));
  if (!item) return;

  assigningItemId = item.id;
  assigningItemTotalQty = item.quantity;

  document.getElementById("assign-modal-title").textContent = `Разложить «${item.printed_name || item.name}»`;
  document.getElementById("assign-info").textContent = `Всего экземпляров: ${item.quantity}`;

  const rowsWrap = document.getElementById("assign-rows");
  rowsWrap.innerHTML = "";

  if (item.boxAssignments.length === 0) {
    addAssignRow(); // хотя бы одна пустая строка для удобства
  } else {
    item.boxAssignments.forEach((a) => addAssignRow(a.box_id, a.quantity));
  }

  assignModal.classList.add("active");
}

function addAssignRow(boxId = "", quantity = "") {
  const rowsWrap = document.getElementById("assign-rows");
  const row = document.createElement("div");
  row.className = "assign-row";
  row.innerHTML = `
    <select class="assign-box-select">
      <option value="">Без коробки</option>
      ${boxesCache.map((b) => `<option value="${b.id}" ${String(b.id) === String(boxId) ? "selected" : ""}>${escapeHtml(b.name)}</option>`).join("")}
    </select>
    <input type="number" class="assign-qty-input" min="1" placeholder="кол-во" value="${quantity}">
    <button class="remove-row-btn" title="Убрать строку">×</button>
  `;
  row.querySelector(".remove-row-btn").addEventListener("click", () => row.remove());
  rowsWrap.appendChild(row);
}

document.getElementById("assign-add-row").addEventListener("click", () => addAssignRow());

document.getElementById("assign-cancel").addEventListener("click", () => {
  assignModal.classList.remove("active");
});
assignModal.addEventListener("click", (e) => {
  if (e.target === assignModal) assignModal.classList.remove("active");
});

document.getElementById("assign-confirm").addEventListener("click", async () => {
  const rows = Array.from(document.querySelectorAll("#assign-rows .assign-row"));

  const newAssignments = rows
    .map((row) => ({
      box_id: row.querySelector(".assign-box-select").value || null,
      quantity: parseInt(row.querySelector(".assign-qty-input").value, 10) || 0,
    }))
    .filter((a) => a.box_id && a.quantity > 0); // строки "без коробки" просто не сохраняем как assignment

  const sumAssigned = newAssignments.reduce((sum, a) => sum + a.quantity, 0);
  if (sumAssigned > assigningItemTotalQty) {
    showToast(`Сумма по коробкам (${sumAssigned}) больше, чем есть карт (${assigningItemTotalQty})`, true);
    return;
  }

  // Простой подход: удаляем все старые назначения этой записи и создаём заново.
  const { error: deleteError } = await db.from("box_assignments").delete().eq("collection_item_id", assigningItemId);
  if (deleteError) {
    showToast("Ошибка обновления распределения: " + deleteError.message, true);
    return;
  }

  if (newAssignments.length > 0) {
    const { error: insertError } = await db.from("box_assignments").insert(
      newAssignments.map((a) => ({
        collection_item_id: assigningItemId,
        box_id: a.box_id,
        quantity: a.quantity,
      }))
    );
    if (insertError) {
      showToast("Ошибка сохранения распределения: " + insertError.message, true);
      return;
    }
  }

  showToast("Распределение по коробкам сохранено");
  assignModal.classList.remove("active");
  loadCollection();
  loadBoxes();
});
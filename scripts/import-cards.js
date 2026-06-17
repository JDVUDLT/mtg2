// scripts/import-cards.js
//
// Скачивает свежий bulk-data файл "Default Cards" со Scryfall,
// стримово парсит его ДВА РАЗА (без загрузки всего файла в память):
//   Проход 1: собираем и заливаем справочник sets (нужен заранее из-за foreign key)
//   Проход 2: заливаем cards, ссылающиеся на уже существующие sets
//
// Запуск: npm run import

import "dotenv/config";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import StreamJsonPkg from "stream-json";
import StreamArrayPkg from "stream-json/streamers/StreamArray.js";

const { parser } = StreamJsonPkg;
const { streamArray } = StreamArrayPkg;

// ---------- Настройки фильтрации ----------
const EXCLUDED_LAYOUTS = new Set([
  "token",
  "emblem",
  "scheme",
  "vanguard",
  "planar",
  "double_faced_token",
  "art_series",
]);

const ONLY_ENGLISH = true;

// ---------- Supabase клиент ----------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Не заданы SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY в .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ---------- Получаем свежую ссылку на Default Cards ----------
async function getDefaultCardsUrl() {
  const res = await fetch("https://api.scryfall.com/bulk-data");
  const json = await res.json();
  const entry = json.data.find((d) => d.type === "default_cards");
  if (!entry) throw new Error("Не найден default_cards в bulk-data ответе");
  console.log(`Найден дамп: ${entry.name}, размер ~${(entry.size / 1024 / 1024).toFixed(0)}MB, обновлён ${entry.updated_at}`);
  return entry.download_uri;
}

function openCardStream(url) {
  // Каждый вызов делает свой fetch — стрим можно прочитать только один раз,
  // поэтому для второго прохода скачиваем файл заново.
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status}`);
    return res.body.pipe(parser()).pipe(streamArray());
  });
}

function shouldKeep(card) {
  if (ONLY_ENGLISH && card.lang !== "en") return false;
  if (EXCLUDED_LAYOUTS.has(card.layout)) return false;
  if (card.set_type === "token" || card.set_type === "memorabilia") return false;
  return true;
}

// Достаём oracle_id с фолбэком на первую грань карты (для составных карт,
// у которых иногда верхнеуровневого oracle_id нет)
function getOracleId(card) {
  if (card.oracle_id) return card.oracle_id;
  if (Array.isArray(card.card_faces) && card.card_faces[0]?.oracle_id) {
    return card.card_faces[0].oracle_id;
  }
  return null;
}

function mapCard(card) {
  const oracleId = getOracleId(card);
  if (!oracleId) return null; // карту без oracle_id пропускаем целиком

  return {
    id: card.id,
    oracle_id: oracleId,
    name: card.name,
    lang: card.lang,
    set_code: card.set,
    collector_number: card.collector_number,
    rarity: card.rarity,
    mana_cost: card.mana_cost ?? null,
    cmc: card.cmc ?? null,
    type_line: card.type_line ?? null,
    oracle_text: card.oracle_text ?? null,
    colors: card.colors ?? null,
    color_identity: card.color_identity ?? null,
    finishes: card.finishes ?? null,
    image_uris: card.image_uris ?? null,
    card_faces: card.card_faces ?? null,
    prices: card.prices ?? null,
    legalities: card.legalities ?? null,
    released_at: card.released_at ?? null,
  };
}

function mapSet(card) {
  return {
    code: card.set,
    name: card.set_name,
    set_type: card.set_type ?? null,
    released_at: card.released_at ?? null,
  };
}

// ---------- Батчевая запись ----------
const BATCH_SIZE = 500;

async function flushCards(batch) {
  if (batch.length === 0) return;
  const { error } = await supabase.from("cards").upsert(batch, { onConflict: "id" });
  if (error) {
    console.error("\nОшибка записи батча cards:", error.message);
  }
}

// ---------- Проход 1: sets ----------
async function importSets(url) {
  console.log("Проход 1/2: собираю справочник сетов...");
  const pipeline = await openCardStream(url);
  const setsMap = new Map();

  for await (const { value: card } of pipeline) {
    if (!shouldKeep(card)) continue;
    if (!setsMap.has(card.set)) {
      setsMap.set(card.set, mapSet(card));
    }
  }

  const rows = Array.from(setsMap.values());
  console.log(`Найдено сетов: ${rows.length}. Заливаю в Supabase...`);

  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await supabase.from("sets").upsert(chunk, { onConflict: "code" });
    if (error) console.error("Ошибка записи sets:", error.message);
  }

  console.log("Справочник сетов загружен.\n");
}

// ---------- Проход 2: cards ----------
async function importCards(url) {
  console.log("Проход 2/2: заливаю карты...");
  const pipeline = await openCardStream(url);

  let cardBatch = [];
  let totalSeen = 0;
  let totalKept = 0;
  let totalSkippedNoOracle = 0;

  for await (const { value: card } of pipeline) {
    totalSeen++;

    if (!shouldKeep(card)) continue;

    const mapped = mapCard(card);
    if (!mapped) {
      totalSkippedNoOracle++;
      continue;
    }

    totalKept++;
    cardBatch.push(mapped);

    if (cardBatch.length >= BATCH_SIZE) {
      await flushCards(cardBatch);
      cardBatch = [];
      process.stdout.write(`\rОбработано: ${totalSeen}, сохранено: ${totalKept}, без oracle_id пропущено: ${totalSkippedNoOracle}`);
    }
  }

  await flushCards(cardBatch);

  console.log(`\n\nГотово! Всего просмотрено карт: ${totalSeen}, сохранено: ${totalKept}, пропущено без oracle_id: ${totalSkippedNoOracle}`);
}

// ---------- Главный процесс ----------
async function main() {
  const url = await getDefaultCardsUrl();
  await importSets(url);
  await importCards(url);
}

main().catch((err) => {
  console.error("Импорт прервался с ошибкой:", err);
  process.exit(1);
});
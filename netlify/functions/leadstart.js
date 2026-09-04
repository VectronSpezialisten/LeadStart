// Leadstart Backend – Netlify Function
//
// Benötigte Umgebungsvariablen (in den Netlify Site-Settings unter
// "Environment variables" eintragen, NIEMALS im Code):
//   WECLAPP_DOMAIN        z.B. eure-domain.weclapp.com
//   WECLAPP_API_TOKEN     euer weclapp AuthenticationToken
//   PERPLEXITY_API_KEY    euer Perplexity API-Key (ohne "Bearer ")
//   SHARED_PASSWORD       gemeinsames Zugangs-Passwort für alle Nutzer
//   ALLOWED_EMAILS        erlaubte E-Mail-Adressen, mit Komma getrennt,
//                         z.B. carsten.brauer@kasse-stimmt.de,anna@kasse-stimmt.de
//
// Aufruf vom Frontend: POST /.netlify/functions/leadstart
// Body: { vorname, nachname, telefon, email, firma, erfasserEmail, passwort }

const WECLAPP_BASE = `https://${process.env.WECLAPP_DOMAIN}/webapp/api/v2`;

// Feste Konfigurationswerte fuer neu erzeugte Tickets (bei Bedarf hier anpassen)
// Bestaetigt per API (ticketCategory/242030): name "Office", parentTicketCategoryId
// "228013" (Team POS), path "Team POS\Office" - die ID ist also korrekt.
const TICKET_CATEGORY_ID = "242030";   // Office (unter Team POS)
const TICKET_STATUS_ID = "1936022";    // Beratung & FollowUp
const TICKET_PRIORITY_ID = "3660";     // normal
const TICKET_CHANNEL_ID = "2539303";   // Vectron Sales
const DEFAULT_ASSIGNED_USER_ID = "17430"; // Karsten Brauer - Fallback, falls kein Bearbeiter ausgewaehlt wurde

// Zuordnung Anmelde-E-Mail -> weclapp-User-ID, fuer die manuelle Bearbeiter-Zuweisung im Formular.
const BEARBEITER_USER_IDS = {
  "karsten.brauer@kasse-stimmt.de": "17430",
  "judith.thiede@kasse-stimmt.de": "17437",
  "katja.malyshkina@kasse-stimmt.de": "1057232"
};

function ermittleAssignedUserId(bearbeiterEmail) {
  const normalisiert = (bearbeiterEmail || "").trim().toLowerCase();
  return BEARBEITER_USER_IDS[normalisiert] || DEFAULT_ASSIGNED_USER_ID;
}

// Custom-Attribute-IDs am Ticket (Gruppe "POS & Pay")
const ATTR_LEAD_ID = "2541107";
const ATTR_LEAD_URL = "2541111";
const ATTR_LEAD_BETRIEBSART = "2541579";
const ATTR_LEAD_GRUND = "2541201";
const LEAD_GRUND_OPTIONEN = {
  "Betreuungswechsel": "2541202",
  "Funktionsupgrade": "2541203",
  "Kosten & Preise": "2541204",
  "Neueröffnung": "2541205",
  "Prozessanforderung": "2541206",
  "Störung": "2541207",
  "Systemwechsel": "2541208",
  "TSE-Ablauf": "2541209",
  "Vertragsablauf": "2541210"
};


// ---------- Zugangsprüfung ----------

function pruefeZugang(erfasserEmail, passwort) {
  const sharedPassword = process.env.SHARED_PASSWORD || "";
  const allowedEmails = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const emailNormalized = (erfasserEmail || "").trim().toLowerCase();

  if (!sharedPassword || passwort !== sharedPassword) {
    return { ok: false, grund: "Falsches Passwort." };
  }
  if (allowedEmails.length === 0) {
    return { ok: false, grund: "Keine erlaubten E-Mail-Adressen konfiguriert." };
  }
  if (!allowedEmails.includes(emailNormalized)) {
    return { ok: false, grund: "Diese E-Mail-Adresse ist nicht freigeschaltet." };
  }
  return { ok: true };
}

// ---------- Normalisierung ----------

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function normalizePhone(phone) {
  if (!phone) return "";
  let p = phone.replace(/[\s\-\/()]/g, "");
  if (p.startsWith("0")) p = "+49" + p.slice(1);
  return p;
}

function normalizeName(name) {
  return (name || "").trim().replace(/\s+/g, " ");
}

function normalizeCompanyName(name) {
  if (!name) return "";
  // WICHTIG: \s+ (mind. ein Leerzeichen) statt \s* vor der Rechtsform-Gruppe -
  // sonst matcht "GmbH" auch MITTEN im Wort, z.B. bei "gGmbH" (gemeinnuetzige
  // GmbH): die letzten 4 Buchstaben "gmbh" wuerden faelschlich als "GmbH"
  // erkannt und abgeschnitten, sodass nur ein einzelnes "g" uebrig bleibt.
  // "gGmbH" steht deshalb zusaetzlich explizit als eigene Rechtsform in der Liste.
  return name
    .trim()
    .replace(/\s+(GmbH\s*&\s*Co\.?\s*KG|gGmbH|GmbH|AG|e\.K\.|OHG|KG|UG)\s*$/i, "")
    .trim();
}

// ---------- weclapp-Zugriff ----------

async function weclappGet(params) {
  const pageSize = 200;
  let page = 1;
  let alleErgebnisse = [];
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`${WECLAPP_BASE}/party`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("page", page);
    url.searchParams.set("pageSize", pageSize);

    const response = await fetch(url.toString(), {
      headers: { AuthenticationToken: process.env.WECLAPP_API_TOKEN }
    });
    if (!response.ok) {
      throw new Error(`weclapp-Fehler (${response.status}) bei ${url.toString()}`);
    }
    const data = await response.json();
    const ergebnisse = data.result || [];
    alleErgebnisse.push(...ergebnisse);

    hasMore = ergebnisse.length === pageSize;
    page++;
  }

  return alleErgebnisse;
}

async function weclappSearchMobilePhone1(targetPhone) {
  let allMatches = [];
  let page = 1;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`${WECLAPP_BASE}/party`);
    url.searchParams.set("page", page);
    url.searchParams.set("pageSize", pageSize);
    url.searchParams.set("properties", "id,firstName,lastName,mobilePhone1,parentPartyId");

    const response = await fetch(url.toString(), {
      headers: { AuthenticationToken: process.env.WECLAPP_API_TOKEN }
    });
    if (!response.ok) {
      throw new Error(`weclapp-Fehler (${response.status}) bei mobilePhone1-Scan, Seite ${page}`);
    }
    const data = await response.json();
    const results = data.result || [];

    allMatches.push(...results.filter((p) => p.mobilePhone1 && p.mobilePhone1.includes(targetPhone)));

    hasMore = results.length === pageSize;
    page++;
  }

  return allMatches;
}

// ---------- Dubletten-Auswertung ----------

const TELEFON_FELDER = ["mobilePhone1", "mobilePhone2", "phone", "fixPhone2"];

function auswertenKontakt(sources, benoetigteKategorien = []) {
  const partyMap = new Map();

  for (const [quelle, results] of Object.entries(sources)) {
    for (const party of results) {
      if (!partyMap.has(party.id)) {
        partyMap.set(party.id, { party, matchedFields: [] });
      }
      partyMap.get(party.id).matchedFields.push(quelle);
    }
  }

  let treffer = Array.from(partyMap.values()).map(({ party, matchedFields }) => {
    const hasEmail = matchedFields.includes("email");
    const hasPhone = matchedFields.some((f) => TELEFON_FELDER.includes(f));

    let confidence;
    if (hasPhone) confidence = "hoch";
    else if (hasEmail) confidence = "mittel";
    else confidence = "niedrig";

    const telefon = party.phone || party.mobilePhone1 || party.mobilePhone2 || party.fixPhone2 || "";

    return {
      id: party.id,
      firstName: party.firstName,
      lastName: party.lastName,
      email: party.email || "",
      telefon,
      parentPartyId: party.parentPartyId || null,
      matchedFields,
      confidence
    };
  });

  treffer = treffer.filter((t) =>
    benoetigteKategorien.every((kategorie) => {
      if (kategorie === "telefon") return t.matchedFields.some((f) => TELEFON_FELDER.includes(f));
      return t.matchedFields.includes(kategorie);
    })
  );

  treffer.sort((a, b) => konfidenzRang(b.confidence) - konfidenzRang(a.confidence));

  let status;
  if (treffer.length === 0) status = "kein Treffer";
  else if (treffer.length === 1) status = "eindeutiger Treffer";
  else status = "mehrere Kandidaten";

  return { status, anzahl: treffer.length, treffer };
}

function auswertenFirma(sources, benoetigteFelder = []) {
  const firmaMap = new Map();

  for (const [quelle, results] of Object.entries(sources)) {
    for (const party of results) {
      if (!firmaMap.has(party.id)) {
        firmaMap.set(party.id, { party, matchedFields: [] });
      }
      firmaMap.get(party.id).matchedFields.push(quelle);
    }
  }

  let treffer = Array.from(firmaMap.values()).map(({ party, matchedFields }) => {
    const adressen = party.addresses || [];
    const adresse = adressen.find((a) => a.primaryAddress) || adressen[0] || {};
    return {
      id: party.id,
      company: party.company,
      company2: party.company2,
      kundennummer: party.customerNumber || "",
      strasse: adresse.street1 || "",
      plz: adresse.zipcode || "",
      ort: adresse.city || "",
      parentPartyId: party.parentPartyId || null,
      matchedFields,
      confidence: firmaKonfidenz(matchedFields)
    };
  });

  treffer = treffer.filter((t) => benoetigteFelder.every((feld) => t.matchedFields.includes(feld)));

  treffer.sort((a, b) => konfidenzRang(b.confidence) - konfidenzRang(a.confidence));

  let status;
  if (treffer.length === 0) status = "kein Treffer";
  else if (treffer.length === 1) status = "eindeutiger Treffer";
  else status = "mehrere Kandidaten";

  return { status, anzahl: treffer.length, treffer };
}

// ---------- Perplexity ----------

async function perplexityRecherche(name, firma) {
  if (!process.env.PERPLEXITY_API_KEY) {
    return "Recherche noch nicht aktiviert (kein Perplexity-API-Key hinterlegt).";
  }

  const prompt = `Recherchiere zu folgenden Angaben aus einem Vertriebs-Lead:
Name: ${name || "unbekannt"}
Firma/Betriebsstätte: ${firma || "unbekannt"}

Falls es sich um eine Gaststätte handelt, ermittle den Betreiber/die Firma dahinter.
Falls es sich um eine Firma handelt, ermittle die zugehörige Gaststätte/Betriebsstätte, falls es eine gibt.
Gib eine kurze, prägnante Einschätzung (max. 4 Sätze) inkl. Rolle der genannten Person (z.B. Geschäftsführer, Inhaber), und kennzeichne unsichere Angaben deutlich als Vermutung.`;

  try {
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      return "Recherche konnte nicht durchgeführt werden (Perplexity-API-Fehler).";
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Keine Recherche möglich.";
  } catch (err) {
    return "Recherche konnte nicht durchgeführt werden (technischer Fehler).";
  }
}


// ---------- Standard-Pflichtfelder fuer neue Party-Objekte ----------
function standardPartyFelder() {
  return {
    commissionBlock: false,
    customerActive: true,
    customerAllowDropshippingOrderCreation: true,
    customerBlocked: false,
    customerDeliveryBlock: false,
    customerInsolvent: false,
    customerInsured: false,
    customerUseCustomsTariffNumber: false,
    enableDropshippingInNewSupplySources: false,
    factoring: false,
    fixedResponsibleUser: false,
    formerSalesPartner: false,
    habitualExporter: false,
    invoiceBlock: false,
    optInEmail: false,
    optInLetter: false,
    optInPhone: false,
    optInSms: false,
    purchaseViaPlafond: false,
    salesPartner: false,
    supplier: false,
    supplierActive: true,
    supplierMergeItemsForOcrInvoiceUpload: false,
    supplierOrderBlock: false
  };
}

async function weclappPost(path, payload) {
  const url = `${WECLAPP_BASE}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      AuthenticationToken: process.env.WECLAPP_API_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`weclapp-Fehler (${response.status}) bei POST ${path}: ${errText}`);
  }
  return response.json();
}

async function weclappPut(path, payload) {
  const url = `${WECLAPP_BASE}${path}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      AuthenticationToken: process.env.WECLAPP_API_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`weclapp-Fehler (${response.status}) bei PUT ${path}: ${errText}`);
  }
  return response.json();
}

async function weclappGetById(path) {
  const url = `${WECLAPP_BASE}${path}`;
  const response = await fetch(url, {
    headers: { AuthenticationToken: process.env.WECLAPP_API_TOKEN }
  });
  if (!response.ok) {
    throw new Error(`weclapp-Fehler (${response.status}) bei GET ${path}`);
  }
  return response.json();
}

async function kontaktAnlegen({ vorname, nachname, telefon, email, anrede }) {
  const lastNameWert = nachname || vorname || "";
  const firstNameWert = nachname ? (vorname || "") : "";

  const payload = {
    partyType: "PERSON",
    firstName: firstNameWert,
    lastName: lastNameWert,
    customerBusinessType: "B2C",
    ...standardPartyFelder()
  };
  if (telefon) payload.mobilePhone1 = telefon;
  if (email) payload.email = email;
  if (anrede) payload.salutation = anrede; // "MR" | "MRS" | "NO_SALUTATION", siehe weclapp-Enum "salutation"

  const created = await weclappPost("/party", payload);
  return created.id;
}

const EMAIL_MUSTER = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function kontaktZuFirmaHinzufuegen(firmaId, kontaktId) {
  const firma = await weclappGetById(`/party/id/${firmaId}`);
  const vorhandeneKontakte = firma.contacts || [];
  const bereitsVerknuepft = vorhandeneKontakte.some((c) => c.id === kontaktId);

  // Schutz gegen leere ("") oder fehlerhaft gespeicherte E-Mail-Adressen am
  // Datensatz: beim vollstaendigen Zurueckschreiben (PUT verlangt das komplette
  // Objekt) wuerde weclapp einen bereits vorhandenen Wert neu validieren und
  // ablehnen, obwohl wir ihn nie selbst gesetzt haben. Das betrifft ausdruecklich
  // auch Kontakte/Firmen ohne hinterlegte E-Mail (dort oft "" statt komplett fehlend).
  if (firma.email !== undefined && !EMAIL_MUSTER.test(firma.email || "")) {
    delete firma.email;
  }

  if (!bereitsVerknuepft) {
    firma.contacts = [...vorhandeneKontakte, { id: kontaktId }];
    await weclappPut(`/party/id/${firmaId}`, firma);
  }
  return { id: firmaId, company: firma.company, company2: firma.company2 };
}

async function firmaAnlegen({ firma, betriebsart, strasse, plz, ort, kontaktId }) {
  const payload = {
    partyType: "ORGANIZATION",
    company: firma || "",
    customerBusinessType: "B2B",
    customer: true, // noetig, damit weclapp eine Kundennummer vergibt - trotzdem
                     // kein "richtiger" Kunde, das steuert weiterhin leadStatus
    customerSalesChannel: "NET1", // "Standard Netto" - Pflichtfeld bei customer: true
    leadStatus: "NEW",
    contacts: kontaktId ? [{ id: kontaktId }] : [],
    ...standardPartyFelder()
  };

  // Adresse wird IMMER angelegt (nicht nur wenn Strasse/PLZ/Ort ausgefuellt sind),
  // weil countryCode an der Adresse Pflichtfeld ist - ohne jede Adresse fehlt
  // sonst das Land komplett, selbst wenn es nur "Deutschland" als Standard waere.
  payload.addresses = [
    {
      street1: strasse || "",
      zipcode: plz || "",
      city: ort || "",
      countryCode: "DE",
      primaryAddress: true
    }
  ];

  const created = await weclappPost("/party", payload);
  return { id: created.id, company: created.company, company2: created.company2 };
}

// Betriebsart, VKC-ID und VKC-URL sind eigene Zusatzfelder (siehe baueCustomAttributes)
// und stehen daher NICHT mehr in der Beschreibung. Die Funktion bleibt bestehen,
// falls spaeter weitere reine Freitext-Meta-Angaben dazukommen.
function baueTicketBeschreibung() {
  return "";
}

function berlinZeitstempel() {
  return new Date().toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function kommentarErstellen(ticketId, notizen, erfasstVon, betriebsart, bearbeiter) {
  // comment.comment ist laut Spezifikation reiner Text (kein "format": "html" wie
  // bei ticket.description) - HTML-Tags wuerden hier woertlich angezeigt statt
  // interpretiert. Deshalb einfache Zeilenumbrueche statt <br>/<b>.
  const kopf = [
    `Absender: ${erfasstVon || "unbekannt"}`,
    `Quelle: Leadstart-App`,
    `Zeitstempel: ${berlinZeitstempel()} Uhr`
  ].join("\n");

  let text = kopf;
  // Betriebsart bewusst hier im Kommentar statt als eigenes Zusatzfeld -
  // dient spaeter als Grundlage fuer eine KI-generierte Zusammenfassung.
  if (betriebsart) {
    text += `\n\nBetriebsart: ${betriebsart}`;
  }
  // Bearbeiter-Vorschlag bewusst nur als Hinweis im Kommentar, nicht als direkt
  // gesetztes Feld - assignedUserId beim Aktualisieren zu setzen fuehrt bei
  // Sales-Navigator-Tickets zuverlaessig zu einem Fehler (siehe ticketAktualisieren).
  if (bearbeiter) {
    text += `\n\nVorschlag Zuweisung: ${bearbeiter} (bitte bei Bedarf manuell in weclapp zuweisen)`;
  }
  if (notizen) {
    text += `\n\n${notizen}`;
  }

  await weclappPost("/comment", {
    entityName: "ticket",
    entityId: ticketId,
    comment: text,
    privateComment: true,
    publicComment: false,
    solution: false
  });
}

// Betriebsart wird bewusst NICHT als eigenes Zusatzfeld gesetzt (siehe
// kommentarErstellen) - landet stattdessen als Text im ersten Kommentar, da
// eigene Betriebsart-Felder an anderer Stelle im System bereits existieren.
function baueCustomAttributes({ vkcId, vkcUrl, leadgrund }) {
  const attrs = [];
  if (vkcId) attrs.push({ attributeDefinitionId: ATTR_LEAD_ID, stringValue: vkcId });
  if (vkcUrl) attrs.push({ attributeDefinitionId: ATTR_LEAD_URL, stringValue: vkcUrl });
  if (leadgrund && LEAD_GRUND_OPTIONEN[leadgrund]) {
    // WICHTIG: Leadgrund ist in weclapp ein Single-Select-Zusatzfeld. Das
    // OpenAPI-Schema kennt fuer customAttributes sowohl "selectedValueId"
    // (einzelner String, fuer Single-Select) als auch "selectedValues"
    // (Array von {id}, fuer Multi-Select). Der bisherige Code nutzte
    // "selectedValues" - dadurch matchte/speicherte weclapp den Leadgrund
    // nicht zuverlaessig. Empirisch zu bestaetigen; falls es weiterhin nicht
    // matcht, bitte im Vergleich mit einem manuell in weclapp gesetzten
    // Leadgrund pruefen, wie das Feld tatsaechlich zurueckgegeben wird.
    attrs.push({
      attributeDefinitionId: ATTR_LEAD_GRUND,
      selectedValueId: LEAD_GRUND_OPTIONEN[leadgrund]
    });
  }
  return attrs;
}

async function ticketAnlegen({ partyId, contactId, subject, beschreibung, solutionDueDate, vkcId, vkcUrl, leadgrund, bearbeiter, betriebsart }) {
  const heute = Date.now();
  const payload = {
    subject: (subject || "Neuer Lead").slice(0, 150),
    description: beschreibung || "",
    partyId,
    contactId,
    ticketCategoryId: TICKET_CATEGORY_ID,
    ticketStatusId: TICKET_STATUS_ID,
    ticketPriorityId: TICKET_PRIORITY_ID,
    ticketChannelId: TICKET_CHANNEL_ID,
    assignedUserId: ermittleAssignedUserId(bearbeiter),
    followUpDate: heute,
    billable: false,
    disableEmailTemplates: false,
    isTemplate: false,
    legacyTimeAndMaterialTicket: false,
    customAttributes: baueCustomAttributes({ vkcId, vkcUrl, leadgrund })
  };

  if (solutionDueDate) {
    const parsed = new Date(solutionDueDate).getTime();
    if (!Number.isNaN(parsed)) payload.solutionDueDate = parsed;
  }

  const created = await weclappPost("/ticket", payload);
  return created;
}

// Laedt alle Tickets der Leadstart-Kategorie (vollstaendig paginiert), um sie
// clientseitig nach VKC-ID/VKC-URL in den Zusatzfeldern zu durchsuchen - es gibt
// keinen dokumentierten Filterpfad fuer customAttributes-Werte.
async function ticketsInLeadstartKategorieLaden() {
  const pageSize = 200;
  let page = 1;
  let alle = [];
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`${WECLAPP_BASE}/ticket`);
    url.searchParams.set("ticketCategoryId-eq", TICKET_CATEGORY_ID);
    url.searchParams.set("page", page);
    url.searchParams.set("pageSize", pageSize);
    url.searchParams.set("properties", "id,ticketNumber,subject,customAttributes");

    const response = await fetch(url.toString(), {
      headers: { AuthenticationToken: process.env.WECLAPP_API_TOKEN }
    });
    if (!response.ok) {
      throw new Error(`weclapp-Fehler (${response.status}) beim Laden der Leadstart-Tickets, Seite ${page}`);
    }
    const data = await response.json();
    const ergebnisse = data.result || [];
    alle.push(...ergebnisse);

    hasMore = ergebnisse.length === pageSize;
    page++;
  }

  return alle;
}

// Prueft, ob zu Ticketnummer, VKC-ID oder VKC-URL bereits ein Ticket existiert.
// Reihenfolge: zuerst Ticketnummer (direkter, schneller exakter Filter), erst
// wenn das nichts findet und VKC-ID/VKC-URL angegeben sind, wird die Kategorie
// vollstaendig geladen und clientseitig auf die Zusatzfelder geprueft.
// Die Ticketnummer wird bewusst NICHT als Pruefkriterium genutzt: der Sales
// Navigator legt sie immer schon VOR jeder Leadstart-Bearbeitung an, sie sagt
// also nichts darueber aus, ob der Lead bereits fertig bearbeitet wurde. Nur
// VKC-ID/VKC-URL (die erst DURCH Leadstart gesetzt werden) zeigen das zuverlaessig.
// "gefunden" (blockierend, Formular bleibt gesperrt) gilt NUR fuer VKC-ID/VKC-URL-
// Treffer, da nur die zuverlaessig anzeigen, dass ein Lead bereits FERTIG bearbeitet
// wurde. Die Ticketnummer wird zusaetzlich rein informativ gesucht (falls angegeben)
// und im Ergebnis mitgeliefert, blockiert das Formular aber ausdruecklich NICHT -
// sie existiert ja bereits, bevor Leadstart ueberhaupt genutzt wird (Sales Navigator
// legt sie automatisch an).
async function leaddetailsPruefen(ticketNummer, vkcId, vkcUrl) {
  let ticketGefunden = null;
  if (ticketNummer) {
    ticketGefunden = await ticketSuchenPerNummer(ticketNummer);
    if (ticketGefunden) {
      // Ob der Hinweis "muss zuerst zugewiesen werden" angezeigt wird, haengt vom
      // TATSAECHLICHEN Status ab - nicht pauschal von "Ticket existiert bereits".
      // ticketStatusId zeigt nur auf die ticketStatus-Entitaet; der interne, stabile
      // Statuswert (internalTicketStatus) muss dafuer separat nachgeladen werden.
      ticketGefunden.nichtZugewiesen = await ticketStatusIstNichtZugewiesen(ticketGefunden.ticketStatusId);
    }
  }

  if (vkcId || vkcUrl) {
    const tickets = await ticketsInLeadstartKategorieLaden();
    for (const ticket of tickets) {
      const attrs = ticket.customAttributes || [];
      const hatVkcId = vkcId && attrs.some((a) => a.attributeDefinitionId === ATTR_LEAD_ID && a.stringValue === vkcId);
      const hatVkcUrl = vkcUrl && attrs.some((a) => a.attributeDefinitionId === ATTR_LEAD_URL && a.stringValue === vkcUrl);
      if (hatVkcId || hatVkcUrl) {
        return { gefunden: true, gefundenUeber: hatVkcId ? "vkcId" : "vkcUrl", ticket, ticketGefunden };
      }
    }
  }

  return { gefunden: false, ticketGefunden };
}

// Laedt die ticketStatus-Entitaet zu einer ticketStatusId und prueft, ob ihr
// interner, kanalunabhaengiger Status "UNASSIGNED" ("Noch nicht zugewiesen") ist.
// Bei einem Fehler (z.B. Status nicht abrufbar) geben wir im Zweifel "false"
// zurueck, um keine falsche Warnung anzuzeigen.
async function ticketStatusIstNichtZugewiesen(ticketStatusId) {
  if (!ticketStatusId) return false;
  try {
    const status = await weclappGetById(`/ticketStatus/id/${ticketStatusId}`);
    return status.internalTicketStatus === "UNASSIGNED";
  } catch (err) {
    return false;
  }
}

async function ticketSuchenPerNummer(ticketNummer) {
  const url = new URL(`${WECLAPP_BASE}/ticket`);
  url.searchParams.set("ticketNumber-eq", ticketNummer);
  const response = await fetch(url.toString(), {
    headers: { AuthenticationToken: process.env.WECLAPP_API_TOKEN }
  });
  if (!response.ok) {
    throw new Error(`weclapp-Fehler (${response.status}) bei Ticketsuche nach Nummer ${ticketNummer}`);
  }
  const data = await response.json();
  const treffer = data.result || [];
  return treffer.length > 0 ? treffer[0] : null;
}

// WICHTIG: ticketStatusId und followUpDate werden beim Aktualisieren bewusst
// NICHT gesetzt. Empirisch nachgewiesen (Vergleich mit einem am 28.08. erfolgreich
// aktualisierten Mail2Ticket-Ticket): Sobald diese Felder beim PUT eines
// bestehenden Tickets mitgeschickt werden, schlaegt der Aufruf bei Tickets aus dem
// Sales-Navigator/Mail2Ticket-Kanal zuverlaessig fehl ("property resolvedYourIssue
// is read-only", unabhaengig vom sonstigen Payload). Ohne diese Felder
// funktioniert derselbe Ablauf nachweislich.
//
// assignedUserId (Bearbeiter) wird jetzt versuchsweise gesetzt: bei Tickets, die
// nicht (mehr) am bekannten Sales-Navigator-Bug haengen - z.B. weil sie zwischen-
// zeitlich manuell zugewiesen wurden - funktioniert das PUT damit direkt. Schlaegt
// der Versuch fehl, wird derselbe PUT unveraendert ohne assignedUserId wiederholt
// (bisheriges Verhalten) - die Bearbeiter-Auswahl landet dann weiterhin zusaetzlich
// als Hinweis im Kommentar, damit sie nicht verloren geht.
async function ticketAktualisieren(ticketId, { partyId, contactId, beschreibung, vkcId, vkcUrl, leadgrund, solutionDueDate, subject, bearbeiter }) {
  const ticket = await weclappGetById(`/ticket/id/${ticketId}`);

  ticket.partyId = partyId;
  ticket.contactId = contactId;
  if (subject) {
    ticket.subject = subject.slice(0, 150);
  }
  // followUpDate wird beim Aktualisieren bewusst NICHT gesetzt: das verlangt
  // zwingend Status "WAITING", den wir hier nicht erzwingen (siehe Kommentar oben).
  if (beschreibung) {
    ticket.description = (ticket.description || "") + "<br><br>" + beschreibung;
  }
  if (solutionDueDate) {
    const parsed = new Date(solutionDueDate).getTime();
    if (!Number.isNaN(parsed)) ticket.solutionDueDate = parsed;
  }

  const neueAttrs = baueCustomAttributes({ vkcId, vkcUrl, leadgrund });
  const bestehendeAttrs = (ticket.customAttributes || []).filter(
    (a) => !neueAttrs.some((n) => n.attributeDefinitionId === a.attributeDefinitionId)
  );
  ticket.customAttributes = [...bestehendeAttrs, ...neueAttrs];

  if (bearbeiter) {
    try {
      const ticketMitBearbeiter = { ...ticket, assignedUserId: ermittleAssignedUserId(bearbeiter) };
      return await weclappPut(`/ticket/id/${ticketId}`, ticketMitBearbeiter);
    } catch (bearbeiterFehler) {
      // Bekannter weclapp-Bug (siehe Kommentar oben) - unveraendert ohne
      // assignedUserId erneut versuchen, statt den ganzen Vorgang abzubrechen.
    }
  }

  const aktualisiert = await weclappPut(`/ticket/id/${ticketId}`, ticket);
  return aktualisiert;
}

async function sucheTeilstringMehrereFelder(text, felder) {
  // Woerter mit weniger als 2 Buchstaben/Ziffern (z.B. ein einzelnes "-" oder "&")
  // werden verworfen - die wuerden sonst als Teilstring in sehr vielen Datensaetzen
  // vorkommen und die Suche unbrauchbar breit machen.
  const tokens = (text || "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((wort) => wort.replace(/[^\wäöüÄÖÜß]/g, "").length >= 2);
  if (tokens.length === 0) return [];

  // BELEGT (nicht nur vermutet): weclapps "-like"-Filter ist case-sensitiv. Der
  // urspruengliche Bug bei "SPI A&Q gGmbH" bewies das bereits - eine Suche nach
  // "Spi" (Title-Case) fand das komplett grossgeschriebene "SPI" NICHT, obwohl
  // eine case-insensitive Suche das trivial gefunden haette. Deshalb werden pro
  // Wort konsequent alle drei Schreibweisen gesucht: komplett klein, komplett
  // GROSS und Title-Case. Das Handelsregister unterscheidet ohnehin nicht nach
  // Gross-/Kleinschreibung - ein Firmenname kann in weclapp in jeder dieser drei
  // Formen hinterlegt sein (normale Namen meist Title-Case wie "Musterfirma",
  // Akronyme oft komplett GROSS wie "SPI" oder "S&P").
  const varianten = new Set();
  for (const wort of tokens) {
    varianten.add(wort.toLowerCase());
    varianten.add(wort.toUpperCase());
    varianten.add(wort.charAt(0).toUpperCase() + wort.slice(1).toLowerCase());
  }

  const promises = [];
  for (const token of varianten) {
    for (const feld of felder) {
      promises.push(weclappGet({ [`${feld}-like`]: `%${token}%` }));
    }
  }
  const ergebnisse = await Promise.all(promises);
  return ergebnisse.flat();
}

async function sucheNachName(nameNormalized) {
  return sucheTeilstringMehrereFelder(nameNormalized, ["firstName", "lastName"]);
}

async function sucheNachFirma(companyNormalized) {
  return sucheTeilstringMehrereFelder(companyNormalized, ["company", "company2"]);
}

// BELEGT im weclapp-OpenAPI-Schema: das Feld "addresses" am party-Objekt ist
// explizit "filterable": false. Serverseitige Filter wie "addresses.city-like"
// oder "addresses.zipcode-eq" werden von der API also gar nicht unterstuetzt -
// eine Suche darueber liefert strukturell nie zuverlaessige Treffer. Deshalb wird
// hier - analog zur bestehenden Voll-Scan-Loesung bei der Telefonnummer-Suche
// (siehe weclappSearchMobilePhone1) - einmalig ueber alle Parteien iteriert und
// der Adressabgleich clientseitig in JS gemacht. Das loest gleichzeitig auch die
// Gross-/Kleinschreibungsfrage fuer Adressfelder, weil der Vergleich selbst
// gesteuert wird, statt auf weclapps (unbekanntes) Filterverhalten angewiesen zu sein.
async function alleParteienMitAdressenLaden() {
  const pageSize = 1000;
  let page = 1;
  let alle = [];
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`${WECLAPP_BASE}/party`);
    url.searchParams.set("page", page);
    url.searchParams.set("pageSize", pageSize);
    url.searchParams.set("properties", "id,company,company2,customerNumber,addresses,parentPartyId");

    const response = await fetch(url.toString(), {
      headers: { AuthenticationToken: process.env.WECLAPP_API_TOKEN }
    });
    if (!response.ok) {
      throw new Error(`weclapp-Fehler (${response.status}) beim Laden aller Firmenadressen, Seite ${page}`);
    }
    const data = await response.json();
    const results = data.result || [];
    alle.push(...results);

    hasMore = results.length === pageSize;
    page++;
  }

  return alle;
}

function adressfeldEnthaeltTeilstring(party, feld, wertNormalisiertKlein) {
  const adressen = party.addresses || [];
  return adressen.some((a) => (a[feld] || "").toLowerCase().includes(wertNormalisiertKlein));
}

function adressfeldIstExaktGleich(party, feld, wertNormalisiertKlein) {
  const adressen = party.addresses || [];
  return adressen.some((a) => (a[feld] || "").toLowerCase() === wertNormalisiertKlein);
}

// Ein einziger Scan fuer Strasse/PLZ/Ort gemeinsam statt drei separaten - vermeidet
// unnoetig dreifaches Laden aller Parteien, wenn mehrere Adressfelder ausgefuellt sind.
async function sucheNachAdresse({ strasse, plz, ort }) {
  const ergebnis = { strasse: [], plz: [], ort: [] };
  if (!strasse && !plz && !ort) return ergebnis;

  const parteien = await alleParteienMitAdressenLaden();
  const strasseKlein = (strasse || "").trim().toLowerCase();
  const plzKlein = (plz || "").trim().toLowerCase();
  const ortKlein = (ort || "").trim().toLowerCase();

  for (const party of parteien) {
    if (strasseKlein && adressfeldEnthaeltTeilstring(party, "street1", strasseKlein)) ergebnis.strasse.push(party);
    // PLZ bewusst als exakter Abgleich (wie zuvor "-eq"), nicht als Teilstring -
    // eine PLZ wie "101" soll nicht "10178" und "10199" gleichermassen treffen.
    if (plzKlein && adressfeldIstExaktGleich(party, "zipcode", plzKlein)) ergebnis.plz.push(party);
    if (ortKlein && adressfeldEnthaeltTeilstring(party, "city", ortKlein)) ergebnis.ort.push(party);
  }

  return ergebnis;
}

function firmaKonfidenz(matchedFields) {
  const hat = (f) => matchedFields.includes(f);
  if (hat("strasse") && hat("plz") && hat("ort")) return "hoch";
  if (hat("name") && hat("plz")) return "hoch";
  if (hat("strasse") && hat("ort") && hat("name")) return "mittel";
  if (hat("ort") && hat("name")) return "mittel";
  return "niedrig";
}

function konfidenzRang(konfidenz) {
  if (konfidenz === "hoch") return 3;
  if (konfidenz === "mittel") return 2;
  return 1;
}

// ---------- Handler ----------

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Nur POST erlaubt" })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Ungültiges JSON im Request-Body" })
    };
  }

  const anredeRaw = body.anrede || "";
  const vornameRaw = body.vorname || "";
  const nachnameRaw = body.nachname || "";
  const vollerName = [vornameRaw, nachnameRaw].filter(Boolean).join(" ").trim();
  const phoneRaw = body.telefon || "";
  const emailRaw = body.email || "";
  const companyRaw = body.firma || "";
  const betriebsart = body.betriebsart || "";
  const strasse = body.strasse || "";
  const plz = body.plz || "";
  const ort = body.ort || "";
  const vkcId = body.vkcId || "";
  const vkcUrl = body.vkcUrl || "";
  const notizen = body.notizen || "";
  const leadgrund = body.leadgrund || "";
  const bearbeiter = body.bearbeiter || "";
  const ticketNummer = body.ticketNummer || "";
  const erfasserEmail = body.erfasserEmail || "";
  const passwort = body.passwort || "";

  const zugang = pruefeZugang(erfasserEmail, passwort);
  if (!zugang.ok) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: zugang.grund })
    };
  }

  // ---------- Action: check_leaddetails (prueft ob Lead per Ticketnummer/VKC bereits existiert) ----------
  if (body.action === "check_leaddetails") {
    try {
      const ergebnis = await leaddetailsPruefen(ticketNummer, vkcId, vkcUrl);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(ergebnis)
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: err.message })
      };
    }
  }

  if (body.action === "create") {
    try {
      const kontaktAuswahl = body.kontakt || { modus: "neu" };
      const firmaAuswahl = body.firma_auswahl || { modus: "neu" };
      const solutionDueDate = body.solutionDueDate || "";

      let kontaktId;
      if (kontaktAuswahl.modus === "vorhanden" && kontaktAuswahl.partyId) {
        kontaktId = kontaktAuswahl.partyId;
      } else {
        kontaktId = await kontaktAnlegen({ vorname: vornameRaw, nachname: nachnameRaw, telefon: phoneRaw, email: emailRaw, anrede: anredeRaw });
      }

      // Eigener try/catch fuer den Firma-Schritt: falls dieser fehlschlaegt,
      // NACHDEM der Kontakt bereits erfolgreich angelegt wurde, soll die
      // Fehlermeldung das deutlich sagen - statt eines verwaisten Kontakts mit
      // einer verwirrenden, allgemeinen Fehlermeldung ohne Kontext.
      let firmaInfo;
      try {
        if (firmaAuswahl.modus === "vorhanden" && firmaAuswahl.partyId) {
          firmaInfo = await kontaktZuFirmaHinzufuegen(firmaAuswahl.partyId, kontaktId);
        } else {
          firmaInfo = await firmaAnlegen({
            firma: companyRaw || vollerName,
            betriebsart,
            strasse,
            plz,
            ort,
            kontaktId
          });
        }
      } catch (firmaFehler) {
        const kontaktHinweis = kontaktAuswahl.modus === "vorhanden"
          ? `Kontakt (bestehend, ID ${kontaktId}) wurde verwendet.`
          : `Kontakt wurde neu angelegt (ID ${kontaktId}) - dieser Kontakt existiert jetzt in weclapp, auch wenn die Firma nicht angelegt werden konnte. Beim naechsten Versuch bitte diesen Kontakt als "vorhanden" auswaehlen, um keine Dublette zu erzeugen.`;
        throw new Error(`Firma konnte nicht angelegt/verknuepft werden: ${firmaFehler.message}. ${kontaktHinweis}`);
      }
      const firmaId = firmaInfo.id;
      const betreffBasis = firmaInfo.company || firmaInfo.company2 || vollerName || "Neuer Lead";
      const betreffName = `${betreffBasis} | Vectron POS`;

      const beschreibung = baueTicketBeschreibung();

      let ticket;
      let aktion;

      if (ticketNummer) {
        const gefundenesTicket = await ticketSuchenPerNummer(ticketNummer);
        if (gefundenesTicket) {
          // Bekannter weclapp-Bug: Tickets aus dem Mail2Ticket/Sales-Navigator-Kanal
          // lassen sich derzeit ueber die API grundsaetzlich nicht per PUT aktualisieren
          // ("property resolvedYourIssue is read-only", unabhaengig vom Payload -
          // manuelle Bearbeitung in der weclapp-Oberflaeche funktioniert einwandfrei).
          // Solange das nicht von weclapp behoben ist: Kontakt/Firma wurden bereits
          // erfolgreich verknuepft, das Ticket selbst faellt zurueck auf "manuell
          // nachtragen", statt den kompletten Vorgang mit einer harten Fehlermeldung
          // abzubrechen.
          try {
            ticket = await ticketAktualisieren(gefundenesTicket.id, {
              partyId: firmaId,
              contactId: kontaktId,
              beschreibung,
              vkcId,
              vkcUrl,
              leadgrund,
              solutionDueDate,
              subject: betreffName,
              bearbeiter
            });
            aktion = "aktualisiert";
          } catch (ticketFehler) {
            // Bekannter weclapp-Bug: Ticket kann nicht aktualisiert werden. Statt
            // manueller Nacharbeit legen wir stattdessen ein NEUES Ticket an (das
            // funktioniert zuverlaessig) und verweisen darin auf die urspruengliche
            // Ticketnummer. Das alte Sales-Navigator-Ticket bleibt unveraendert bestehen.
            ticket = await ticketAnlegen({
              partyId: firmaId,
              contactId: kontaktId,
              subject: betreffName,
              beschreibung: beschreibung + `<br><br><i>Hinweis: Ticket "${gefundenesTicket.ticketNumber}" konnte nicht automatisch aktualisiert werden - vermutlich weil es noch im Status "Noch nicht zugewiesen" ist (dieser Uebergang scheitert bei Sales-Navigator-Tickets ueber die API empirisch immer, funktioniert aber manuell in weclapp problemlos). Dieses neue Ticket wurde stattdessen angelegt. Tipp: Wird "${gefundenesTicket.ticketNumber}" zuerst manuell in weclapp einem Bearbeiter zugewiesen, sollte eine erneute Aktualisierung ueber Leadstart danach funktionieren - das urspruengliche Ticket bleibt bis dahin unveraendert bestehen.</i>`,
              solutionDueDate,
              vkcId,
              vkcUrl,
              leadgrund,
              bearbeiter,
              betriebsart
            });
            aktion = "neu_angelegt_ticket_update_fehlgeschlagen";
          }
        } else {
          ticket = await ticketAnlegen({
            partyId: firmaId,
            contactId: kontaktId,
            subject: betreffName,
            beschreibung: beschreibung + `<br><br><i>Hinweis: Ticketnummer "${ticketNummer}" wurde nicht gefunden, neues Ticket wurde stattdessen angelegt.</i>`,
            solutionDueDate,
            vkcId,
            vkcUrl,
            leadgrund,
            bearbeiter,
            betriebsart
          });
          aktion = "neu_angelegt_ticketnummer_nicht_gefunden";
        }
      } else {
        ticket = await ticketAnlegen({
          partyId: firmaId,
          contactId: kontaktId,
          subject: betreffName,
          beschreibung,
          solutionDueDate,
          vkcId,
          vkcUrl,
          leadgrund,
          bearbeiter,
          betriebsart
        });
        aktion = "neu_angelegt";
      }

      await kommentarErstellen(ticket.id, notizen, erfasserEmail, betriebsart, bearbeiter);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          erfolg: true,
          aktion,
          kontaktId,
          firmaId,
          ticketId: ticket.id,
          ticketNummer: ticket.ticketNumber,
          ticketSubject: ticket.subject
        })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: err.message })
      };
    }
  }

  const nameNormalized = normalizeName(vollerName);
  const emailNormalized = normalizeEmail(emailRaw);
  const phoneNormalized = normalizePhone(phoneRaw);
  const companyNormalized = normalizeCompanyName(companyRaw);

  try {
    const [
      emailResults,
      mobilePhone1Results,
      mobilePhone2Results,
      phoneResults,
      fixPhone2Results,
      nameResults,
      companyResults,
      adressTreffer
    ] = await Promise.all([
      emailNormalized ? weclappGet({ "email-like": `%${emailNormalized}%` }) : [],
      phoneNormalized ? weclappSearchMobilePhone1(phoneNormalized) : [],
      phoneNormalized ? weclappGet({ "mobilePhone2-like": `%${phoneNormalized}%` }) : [],
      phoneNormalized ? weclappGet({ "phone-like": `%${phoneNormalized}%` }) : [],
      phoneNormalized ? weclappGet({ "fixPhone2-like": `%${phoneNormalized}%` }) : [],
      nameNormalized ? sucheNachName(nameNormalized) : [],
      companyNormalized ? sucheNachFirma(companyNormalized) : [],
      sucheNachAdresse({ strasse, plz, ort })
    ]);

    const benoetigteKontaktKategorien = [];
    if (nameNormalized) benoetigteKontaktKategorien.push("name");
    if (emailNormalized) benoetigteKontaktKategorien.push("email");
    if (phoneNormalized) benoetigteKontaktKategorien.push("telefon");

    const kontaktErgebnis = auswertenKontakt(
      {
        email: emailResults,
        mobilePhone1: mobilePhone1Results,
        mobilePhone2: mobilePhone2Results,
        phone: phoneResults,
        fixPhone2: fixPhone2Results,
        name: nameResults
      },
      benoetigteKontaktKategorien
    );

    const benoetigteFirmaFelder = [];
    if (companyNormalized) benoetigteFirmaFelder.push("name");
    if (strasse) benoetigteFirmaFelder.push("strasse");
    if (plz) benoetigteFirmaFelder.push("plz");
    if (ort) benoetigteFirmaFelder.push("ort");

    const firmaErgebnis = auswertenFirma(
      {
        name: companyResults,
        strasse: adressTreffer.strasse,
        plz: adressTreffer.plz,
        ort: adressTreffer.ort
      },
      benoetigteFirmaFelder
    );

    const perplexityText = await perplexityRecherche(vollerName, companyRaw);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        status: kontaktErgebnis.status,
        anzahl: kontaktErgebnis.anzahl,
        treffer: kontaktErgebnis.treffer,
        firma: firmaErgebnis,
        perplexity: perplexityText,
        eingabe: {
          vorname: vornameRaw,
          nachname: nachnameRaw,
          telefon: phoneRaw,
          email: emailRaw,
          firma: companyRaw,
          betriebsart,
          strasse,
          plz,
          ort,
          vkcId,
          vkcUrl,
          notizen,
          leadgrund,
          ticketNummer
        },
        erfasstVon: erfasserEmail
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
};

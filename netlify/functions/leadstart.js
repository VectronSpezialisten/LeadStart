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
// Body: { name, telefon, email, firma, erfasserEmail, passwort }

const WECLAPP_BASE = `https://${process.env.WECLAPP_DOMAIN}/webapp/api/v2`;

// Feste Konfigurationswerte fuer neu erzeugte Tickets (bei Bedarf hier anpassen)
const TICKET_CATEGORY_ID = "242030";   // Office (unter Team POS)
const TICKET_STATUS_ID = "1936022";    // Beratung & FollowUp
const TICKET_PRIORITY_ID = "3660";     // normal
const TICKET_CHANNEL_ID = "2539303";   // Vectron Sales


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
  return name
    .trim()
    .replace(/\s*(GmbH & Co\.?\s*KG|GmbH|AG|e\.K\.|OHG|KG|UG)\s*$/i, "")
    .trim();
}

// ---------- weclapp-Zugriff ----------

async function weclappGet(params) {
  const url = new URL(`${WECLAPP_BASE}/party`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    headers: { AuthenticationToken: process.env.WECLAPP_API_TOKEN }
  });
  if (!response.ok) {
    throw new Error(`weclapp-Fehler (${response.status}) bei ${url.toString()}`);
  }
  const data = await response.json();
  return data.result || [];
}

// mobilePhone1 ist bei weclapp strukturell nicht filterbar (x-weclapp.filterable: false,
// bestätigt sowohl in API v1 als auch v2). Daher: alle Kontakte seitenweise laden und
// im Code vergleichen. Nichts davon wird gespeichert, nur für diesen einen Request genutzt.
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

    allMatches.push(...results.filter((p) => p.mobilePhone1 === targetPhone));

    hasMore = results.length === pageSize;
    page++;
  }

  return allMatches;
}

// ---------- Dubletten-Auswertung ----------

function auswertenKontakt(sources) {
  const partyMap = new Map();

  for (const [quelle, results] of Object.entries(sources)) {
    for (const party of results) {
      if (!partyMap.has(party.id)) {
        partyMap.set(party.id, { party, matchedFields: [] });
      }
      partyMap.get(party.id).matchedFields.push(quelle);
    }
  }

  const treffer = Array.from(partyMap.values()).map(({ party, matchedFields }) => {
    const hasEmail = matchedFields.includes("email");
    const hasPhone = matchedFields.some((f) =>
      ["mobilePhone1", "mobilePhone2", "phone", "fixPhone2"].includes(f)
    );

    let confidence;
    if (hasPhone) confidence = "hoch";
    else if (hasEmail) confidence = "mittel";
    else confidence = "niedrig";

    return {
      id: party.id,
      firstName: party.firstName,
      lastName: party.lastName,
      email: party.email,
      parentPartyId: party.parentPartyId || null,
      matchedFields,
      confidence
    };
  });

  let status;
  if (treffer.length === 0) status = "kein Treffer";
  else if (treffer.length === 1) status = "eindeutiger Treffer";
  else status = "mehrere Kandidaten";

  return { status, anzahl: treffer.length, treffer };
}

function auswertenFirma(sources) {
  const firmaMap = new Map();

  for (const [quelle, results] of Object.entries(sources)) {
    for (const party of results) {
      if (!firmaMap.has(party.id)) {
        firmaMap.set(party.id, { party, matchedFields: [] });
      }
      firmaMap.get(party.id).matchedFields.push(quelle);
    }
  }

  const treffer = Array.from(firmaMap.values()).map(({ party, matchedFields }) => ({
    id: party.id,
    company: party.company,
    company2: party.company2,
    parentPartyId: party.parentPartyId || null,
    matchedFields
  }));

  let status;
  if (treffer.length === 0) status = "kein Treffer";
  else if (treffer.length === 1) status = "eindeutiger Treffer";
  else status = "mehrere Kandidaten";

  return { status, anzahl: treffer.length, treffer };
}

// ---------- Perplexity ----------

async function perplexityRecherche(name, firma) {
  // Solange kein Key hinterlegt ist: sauber überspringen, kein Fehler, kein Blockieren des restlichen Ergebnisses.
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
    // Netzwerkfehler o.ä. sollen den restlichen Duplikat-Check nicht zu Fall bringen.
    return "Recherche konnte nicht durchgeführt werden (technischer Fehler).";
  }
}


// ---------- Standard-Pflichtfelder fuer neue Party-Objekte ----------
// Diese Werte spiegeln ein real bestehendes party-Objekt wider (empirisch geprueft),
// damit beim Anlegen keine der zahlreichen weclapp-Pflichtfelder fehlt.
function standardPartyFelder() {
  return {
    commissionBlock: false,
    competitor: false,
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

// Neuen Kontakt (Person) anlegen. Bewusst nur ein Namensfeld (firstName) befuellt,
// kein Split in Vor-/Nachname, wie im Lead-Prozess an anderer Stelle schon festgelegt.
async function kontaktAnlegen({ name, telefon, email }) {
  const payload = {
    partyType: "PERSON",
    firstName: name || "",
    customerBusinessType: "B2C",
    ...standardPartyFelder()
  };
  if (telefon) payload.mobilePhone1 = telefon;
  if (email) payload.email = email;

  const created = await weclappPost("/party", payload);
  return created.id;
}

// Bestehende Firma laden, Kontakt-ID im contacts-Array ergaenzen (nicht ersetzen),
// falls er dort noch nicht steht. Bestehende Verknuepfungen des Kontakts bleiben unberuehrt.
async function kontaktZuFirmaHinzufuegen(firmaId, kontaktId) {
  const firma = await weclappGetById(`/party/id/${firmaId}`);
  const vorhandeneKontakte = firma.contacts || [];
  const bereitsVerknuepft = vorhandeneKontakte.some((c) => c.id === kontaktId);

  if (!bereitsVerknuepft) {
    firma.contacts = [...vorhandeneKontakte, { id: kontaktId }];
    await weclappPut(`/party/id/${firmaId}`, firma);
  }
  return firmaId;
}

// Neue Firma anlegen, Kontakt direkt im contacts-Array mitgeben.
async function firmaAnlegen({ firma, betriebsart, strasse, plz, ort, kontaktId }) {
  const payload = {
    partyType: "ORGANIZATION",
    company: firma || "",
    customerBusinessType: "B2B",
    contacts: kontaktId ? [{ id: kontaktId }] : [],
    ...standardPartyFelder()
  };

  if (strasse || plz || ort) {
    payload.addresses = [
      {
        street1: strasse || "",
        zipcode: plz || "",
        city: ort || "",
        countryCode: "DE",
        primaryAddress: true
      }
    ];
  }

  const created = await weclappPost("/party", payload);
  return created.id;
}

function baueTicketBeschreibung({ notizen, betriebsart, vkcId, vkcUrl, erfasstVon }) {
  let teile = [];
  if (notizen) teile.push(notizen.replace(/\n/g, "<br>"));
  if (betriebsart) teile.push(`<br><br><b>Betriebsart:</b> ${betriebsart}`);
  if (vkcId) teile.push(`<br><b>VKC-ID:</b> ${vkcId}`);
  if (vkcUrl) teile.push(`<br><b>VKC-URL:</b> <a href="${vkcUrl}">${vkcUrl}</a>`);
  if (erfasstVon) teile.push(`<br><br><i>Erfasst über Leadstart von: ${erfasstVon}</i>`);
  return teile.join("");
}

async function ticketAnlegen({ partyId, contactId, subject, beschreibung, solutionDueDate }) {
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
    followUpDate: heute,
    billable: false,
    disableEmailTemplates: false,
    isTemplate: false,
    legacyTimeAndMaterialTicket: false
  };

  if (solutionDueDate) {
    const parsed = new Date(solutionDueDate).getTime();
    if (!Number.isNaN(parsed)) payload.solutionDueDate = parsed;
  }

  const created = await weclappPost("/ticket", payload);
  return created;
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

  const nameRaw = body.name || "";
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

  // ---------- Action: create (Firma/Kontakt anlegen, Ticket erzeugen) ----------
  if (body.action === "create") {
    try {
      const kontaktAuswahl = body.kontakt || { modus: "neu" };
      const firmaAuswahl = body.firma_auswahl || { modus: "neu" };
      const solutionDueDate = body.solutionDueDate || "";

      let kontaktId;
      if (kontaktAuswahl.modus === "vorhanden" && kontaktAuswahl.partyId) {
        kontaktId = kontaktAuswahl.partyId;
      } else {
        kontaktId = await kontaktAnlegen({ name: nameRaw, telefon: phoneRaw, email: emailRaw });
      }

      let firmaId;
      if (firmaAuswahl.modus === "vorhanden" && firmaAuswahl.partyId) {
        firmaId = await kontaktZuFirmaHinzufuegen(firmaAuswahl.partyId, kontaktId);
      } else {
        firmaId = await firmaAnlegen({
          firma: companyRaw,
          betriebsart,
          strasse,
          plz,
          ort,
          kontaktId
        });
      }

      const beschreibung = baueTicketBeschreibung({ notizen, betriebsart, vkcId, vkcUrl, erfasstVon: erfasserEmail });
      const ticket = await ticketAnlegen({
        partyId: firmaId,
        contactId: kontaktId,
        subject: companyRaw || nameRaw,
        beschreibung,
        solutionDueDate
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          erfolg: true,
          kontaktId,
          firmaId,
          ticketId: ticket.id,
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

  // ---------- Action: check (Standardverhalten, bisherige Logik) ----------
  const nameNormalized = normalizeName(nameRaw);
  const emailNormalized = normalizeEmail(emailRaw);
  const phoneNormalized = normalizePhone(phoneRaw);
  const companyNormalized = normalizeCompanyName(companyRaw);

  try {
    // Alle Suchen parallel starten
    const [
      emailResults,
      mobilePhone1Results,
      mobilePhone2Results,
      phoneResults,
      fixPhone2Results,
      nameAlsVorname,
      nameAlsNachname,
      companyResults,
      company2Results
    ] = await Promise.all([
      emailNormalized ? weclappGet({ "email-eq": emailNormalized }) : [],
      phoneNormalized ? weclappSearchMobilePhone1(phoneNormalized) : [],
      phoneNormalized ? weclappGet({ "mobilePhone2-eq": phoneNormalized }) : [],
      phoneNormalized ? weclappGet({ "phone-eq": phoneNormalized }) : [],
      phoneNormalized ? weclappGet({ "fixPhone2-eq": phoneNormalized }) : [],
      nameNormalized ? weclappGet({ "firstName-eq": nameNormalized }) : [],
      nameNormalized ? weclappGet({ "lastName-eq": nameNormalized }) : [],
      companyNormalized ? weclappGet({ "company-eq": companyNormalized }) : [],
      companyNormalized ? weclappGet({ "company2-eq": companyNormalized }) : []
    ]);

    const kontaktErgebnis = auswertenKontakt({
      email: emailResults,
      mobilePhone1: mobilePhone1Results,
      mobilePhone2: mobilePhone2Results,
      phone: phoneResults,
      fixPhone2: fixPhone2Results,
      nameAlsVorname,
      nameAlsNachname
    });

    const firmaErgebnis = auswertenFirma({
      company: companyResults,
      company2: company2Results
    });

    const perplexityText = await perplexityRecherche(nameRaw, companyRaw);

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
          name: nameRaw,
          telefon: phoneRaw,
          email: emailRaw,
          firma: companyRaw,
          betriebsart,
          strasse,
          plz,
          ort,
          vkcId,
          vkcUrl,
          notizen
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

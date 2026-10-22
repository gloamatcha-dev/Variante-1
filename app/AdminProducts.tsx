"use client";
import { useEffect, useState } from 'react';
import Image from 'next/image';
import { portalRequest } from './AdminPortalShared';
import { PRODUCT_TYPES, PRODUCT_TAX_CATEGORIES, validProductImage, type ProductDraft, type ProductVariantDraft } from '../lib/productManagerRules';
import { newEditorVariant, editVariant, editorDocument, parseProductPrice, TAX_CATEGORY_LABELS, type EditorProduct, type EditorVariant } from '../lib/productEditor';
import { productImageSourceError } from '../lib/productImageRules';
import { optimizeProductImage, transferProductImage } from '../lib/productImageBrowser';

type Inventory = { id: string; name: string; unit: string; current_quantity: number; is_active: boolean };
type Product = Omit<ProductDraft, 'variants'> & { id: string; product_variants: ProductVariantDraft[];
  stripe_sync_revision: number; stripe_sync_status: string; stripe_sync_error: string | null; is_active: boolean; archived_at: string | null; updated_at: string };
const blank = (): EditorProduct => ({ name: '', slug: '', product_type: 'ACCESSORY', short_description: '', description: '', primary_image_path: '', sort_order: 0, variants: [newEditorVariant()] });
const state = (p: Product) => p.archived_at ? 'Archiviert' : p.is_active ? 'Veröffentlicht' : 'Entwurf';
const euros = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

export function AdminProducts() {
  const [products, setProducts] = useState<Product[]>([]), [inventory, setInventory] = useState<Inventory[]>([]);
  const [writable, setWritable] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ id: string; revision: number; document: EditorProduct; persisted: string[]; wasPublished?: boolean } | null>(null);
  const [unpublishAcknowledged, setUnpublishAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false), [imageError, setImageError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [publicationStatus, setPublicationStatus] = useState('');
  const [unresolvedProduct, setUnresolvedProduct] = useState<string | null>(null);
  const [imageStatus, setImageStatus] = useState(''), [imageProgress, setImageProgress] = useState<number | null>(null);
  const [imagePreview, setImagePreview] = useState('');
  useEffect(() => () => { if (imagePreview) URL.revokeObjectURL(imagePreview); }, [imagePreview]);
  async function reload() {
    const data = await portalRequest('/api/admin/products', { action: 'list' });
    setProducts(data.products as Product[]); setInventory(data.inventory as Inventory[]); setWritable(data.canWrite === true); setLoaded(true);
  }
  useEffect(() => { let active = true;
    portalRequest('/api/admin/products', { action: 'list' }).then(data => {
      if (active) { setProducts(data.products as Product[]); setInventory(data.inventory as Inventory[]); setWritable(data.canWrite === true); setLoaded(true); }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  async function act(action: string, p: { id: string; stripe_sync_revision: number }, document?: ProductDraft) {
    setBusy(true); setError(''); setPublicationStatus('');
    try {
      await portalRequest('/api/admin/products', { action, id: p.id, revision: p.stripe_sync_revision, operationId: crypto.randomUUID(), ...(document ? { document } : {}) });
      setEditor(null); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'Aktion fehlgeschlagen.'); await reload().catch(() => {}); }
    finally { setBusy(false); }
  }
  async function reconcilePublication(id: string, completed = false, failure = '') {
    // The recovery path consists only of reads, including after a disconnected stream.
    await reload().catch(() => {});
    try {
      const result = await portalRequest('/api/admin/products', { action: 'publication-status', id });
      if (result.id !== id || !['published', 'draft', 'archived'].includes(String(result.status))) throw Error('Unconfirmed status');
      setProducts(current => current.map(product => product.id === id ? { ...product,
        is_active: result.status === 'published', archived_at: result.status === 'archived' ? String(result.archivedAt) : null,
        stripe_sync_revision: typeof result.revision === 'number' ? result.revision : product.stripe_sync_revision,
        stripe_sync_status: typeof result.stripeSyncStatus === 'string' ? result.stripeSyncStatus : product.stripe_sync_status,
      } : product));
      setUnresolvedProduct(null);
      setPublicationStatus(result.status === 'published' ? (completed ? 'Veröffentlichung abgeschlossen' : 'Veröffentlicht')
        : result.status === 'draft' ? 'Entwurf' : 'Archiviert');
      setError(result.status === 'draft' ? failure : '');
    } catch {
      setUnresolvedProduct(id); setError(''); setPublicationStatus('Status unklar — bitte aktualisieren');
    }
  }
  async function publish(p: { id: string; stripe_sync_revision: number }) {
    if (busy || unresolvedProduct === p.id) return;
    setUnresolvedProduct(p.id);
    setBusy(true); setError(''); setPublicationStatus('Prüfung läuft');
    try {
      const response = await fetch('/api/admin/products', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ action: 'review-publish', id: p.id, revision: p.stripe_sync_revision, operationId: crypto.randomUUID() }) });
      if (!response.ok) { const failed = await response.json(); throw Error(failed.error || 'Veröffentlichung fehlgeschlagen.'); }
      const reader = response.body?.getReader();
      if (!reader) throw Error('Veröffentlichung nicht bestätigt. Bitte neu laden.');
      const decoder = new TextDecoder(); let buffer = '', confirmed = false;
      try { while (true) {
        const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (event.error) throw Error(event.error);
          if (event.stage && event.stage !== 'Veröffentlichung abgeschlossen') setPublicationStatus(event.stage);
          if (event.ok === true && event.published === true) confirmed = true;
        }
        if (done) break;
      } } finally { reader.releaseLock(); }
      if (!confirmed || buffer.trim()) throw Error('Veröffentlichung nicht bestätigt. Bitte neu laden und erneut prüfen.');
      await reconcilePublication(p.id, true);
    } catch (e) { await reconcilePublication(p.id, false, e instanceof Error ? e.message : 'Veröffentlichung nicht bestätigt.'); }
    finally { setBusy(false); }
  }
  function edit(p: Product) {
    setSubmitted(false); setImageError('');
    setUnpublishAcknowledged(false);
    setEditor({ id: p.id, revision: p.stripe_sync_revision, wasPublished: p.is_active, persisted: p.product_variants.map(v => v.id), document: {
      name: p.name, slug: p.slug, product_type: p.product_type, short_description: p.short_description ?? '', description: p.description ?? '',
      primary_image_path: p.primary_image_path ?? '', sort_order: p.sort_order, variants: p.product_variants.map(editVariant) } });
  }
  function field<K extends keyof EditorProduct>(key: K, value: EditorProduct[K]) {
    setEditor(e => e ? { ...e, document: { ...e.document, [key]: value } } : e);
  }
  function variant(id: string, patch: Partial<EditorVariant>) {
    if (editor) field('variants', editor.document.variants.map(v => v.id === id ? { ...v, ...patch } : v));
  }
  async function upload(file: File) {
    if (!editor || busy) return;
    setImageError('');
    const invalid = productImageSourceError(file.type, file.size);
    if (invalid) { setImageError(invalid); return; }
    const editorId = editor.id;
    setBusy(true);
    setImageProgress(null); setImageStatus('Bild wird auf diesem Computer optimiert …');
    try {
      const optimized = await optimizeProductImage(file);
      setImagePreview(URL.createObjectURL(optimized));
      const control = async (body: Record<string, unknown>) => {
        const response = await fetch('/api/admin/products?action=upload-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (response.status === 401) throw new Error('Sitzung abgelaufen. Bitte erneut anmelden.');
        if (response.status === 403) throw new Error('Für den Bild-Upload fehlt die Berechtigung.');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Das Bild konnte nicht hochgeladen werden.');
        return data;
      };
      setImageStatus('Upload wird vorbereitet …');
      const prepared = await control({ phase: 'prepare', mime: optimized.type, size: optimized.size });
      setImageStatus('Optimiertes Bild wird hochgeladen …');
      await transferProductImage(prepared.uploadUrl, optimized, setImageProgress);
      setImageProgress(null); setImageStatus('Bild wird sicher geprüft …');
      const data = await control({ phase: 'complete', mime: optimized.type, path: prepared.path });
      if (typeof data.url !== 'string' || !validProductImage(data.url)) throw new Error('Ungültige Bildreferenz.');
      setEditor(e => e?.id === editorId ? { ...e, document: { ...e.document, primary_image_path: data.url } } : e);
    } catch (e) { setImageError(e instanceof Error ? e.message : 'Bild-Upload fehlgeschlagen.'); }
    finally { setBusy(false); setImagePreview(''); setImageStatus(''); setImageProgress(null); }
  }
  function save() {
    if (!editor || busy) return;
    setSubmitted(true); setError('');
    if (editor.wasPublished && !unpublishAcknowledged) {
      setError('Bitte bestätigen: Speichern nimmt das Produkt bis zum erneuten Stripe-Abgleich und Veröffentlichen aus dem Verkauf.');
      return;
    }
    try { const document = editorDocument(editor.document); void act('save', { id: editor.id, stripe_sync_revision: editor.revision }, document); }
    catch (e) { setError(e instanceof Error ? e.message : 'Bitte die Produktfelder prüfen.'); }
  }
  const d = editor?.document;
  return <section className="admin-products"><div className="portal-section-head"><h2>PRODUKTE</h2>
    {writable && <button type="button" disabled={busy} onClick={() => { setSubmitted(false); setImageError(''); setError(''); setEditor({ id: crypto.randomUUID(), revision: 0, document: blank(), persisted: [] }); }}>NEUES PRODUKT</button>}
    <button type="button" disabled={busy} onClick={() => void (unresolvedProduct ? reconcilePublication(unresolvedProduct) : reload()).catch(e => setError(e.message))}>Neu laden</button></div>
    <p>Physische Standardversand-Produkte, einmaliger Kauf. Bestand wird ausschließlich manuell gebucht. Speichern setzt das Produkt auf Entwurf.</p>
    {error && <p role="alert" className="portal-error">{error}</p>}
    {publicationStatus && <p role="status" aria-live="polite">{publicationStatus}</p>}
    {!loaded && !error && <p role="status">Katalog wird geladen …</p>}
    {editor && d && <form onSubmit={e => { e.preventDefault(); save(); }} onInvalid={() => setSubmitted(true)} className="product-editor">
      <h3>Produkt bearbeiten</h3>
      {editor.wasPublished && <p role="note" className="product-publish-warning">Dieses Produkt ist veröffentlicht. Speichern setzt es sofort auf Entwurf und sperrt neue Käufe. Anschließend bitte erneut prüfen und veröffentlichen.</p>}
      <div className="product-field-help"><label>Name<input required maxLength={120} value={d.name} onChange={e => field('name', e.target.value)} /></label><details><summary aria-label="Hilfe: Name">ⓘ</summary><p>Pflichtfeld. Produktname im Shop, maximal 120 Zeichen, z. B. GLOA Bambusbesen.</p></details></div>
      <div className="product-field-help"><label>Slug<input required maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={d.slug} onChange={e => field('slug', e.target.value)} /></label><details><summary aria-label="Hilfe: Slug">ⓘ</summary><p>Pflichtfeld. Eindeutiger Teil der Produktadresse, z. B. bambusbesen. Nur Kleinbuchstaben, Zahlen und Bindestriche, maximal 64 Zeichen. Änderungen verändern die Produktadresse.</p></details></div>
      <div className="product-field-help"><label>Typ<select value={d.product_type} onChange={e => field('product_type', e.target.value as ProductDraft['product_type'])}>{PRODUCT_TYPES.map(t => <option key={t}>{t}</option>)}</select></label><details><summary aria-label="Hilfe: Typ">ⓘ</summary><p>Pflichtauswahl. MATCHA, MERCH, ACCESSORY (Zubehör) oder BUNDLE (Set) wählen. Der Typ ersetzt keine Steuerklassifikation und legt kein Abo an.</p></details></div>
      <div className="product-field-help"><label>Kurzbeschreibung<textarea maxLength={500} value={d.short_description} onChange={e => field('short_description', e.target.value)} /></label><details><summary aria-label="Hilfe: Kurzbeschreibung">ⓘ</summary><p>Optional. Kurzer Produkttext, maximal 500 Zeichen, z. B. Bambusbesen zum Aufschlagen von Matcha.</p></details></div>
      <div className="product-field-help"><label>Beschreibung<textarea maxLength={10000} rows={5} value={d.description} onChange={e => field('description', e.target.value)} /></label><details><summary aria-label="Hilfe: Beschreibung">ⓘ</summary><p>Optional. Ausführlicher Produkttext, maximal 10.000 Zeichen, z. B. Material, Verwendung und Pflegehinweise.</p></details></div>
      <div className="product-field-help"><label>Produktbild auswählen oder austauschen<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} aria-describedby="product-image-help product-image-error" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }} /></label><details><summary aria-label="Hilfe: Produktbild auswählen oder austauschen">ⓘ</summary><p>Optional. JPG, PNG oder WebP auswählen. Nach dem Upload das Produkt als Entwurf speichern. Bilder werden nicht an Stripe übertragen.</p></details></div>
      <p id="product-image-help">JPG, PNG oder WebP, maximal 50 MiB. Das Bild wird vor dem Upload auf höchstens 5 MiB optimiert. Das bisherige Bild bleibt bis zu einem erfolgreichen Austausch erhalten.</p>
      <p id="product-image-error" role={imageError ? 'alert' : undefined}>{imageError}</p>
      {imageStatus && <p role="status">{imageStatus}{imageProgress !== null && ` ${imageProgress} %`}</p>}
      {imageStatus && <progress max={100} value={imageProgress ?? undefined} aria-label="Bild-Upload" />}
      {(imagePreview || (d.primary_image_path && validProductImage(d.primary_image_path))) && <Image unoptimized width={180} height={180} className="product-preview" src={imagePreview || d.primary_image_path} alt="Produktvorschau" referrerPolicy="no-referrer" />}
      <div className="product-field-help"><label>Sortierung<input type="number" value={d.sort_order} onChange={e => field('sort_order', Number(e.target.value))} /></label><details><summary aria-label="Hilfe: Sortierung">ⓘ</summary><p>Ganzzahl für die Katalogreihenfolge. Kleinere Werte stehen weiter vorn; gleiche Werte sind möglich.</p></details></div>
      {d.variants.map(v => { const linked = inventory.find(i => i.id === v.inventory_item_id); return <fieldset key={v.id}><legend>{v.label || 'Neue Variante'}</legend>
        <div className="product-field-help"><label>SKU<input required maxLength={60} pattern="[A-Z0-9][A-Z0-9_-]*" readOnly={editor.persisted.includes(v.id)} value={v.sku} onChange={e => variant(v.id, { sku: e.target.value })} /></label><details><summary aria-label="Hilfe: SKU">ⓘ</summary><p>Pflichtfeld. Eindeutige Artikelnummer je Variante, z. B. GLOA-BESEN-01. Maximal 60 Zeichen: Großbuchstaben, Zahlen, Bindestriche oder Unterstriche; erstes Zeichen Buchstabe oder Zahl. Nach dem Speichern unveränderlich.</p></details></div>
        <div className="product-field-help"><label>Bezeichnung<input required maxLength={120} value={v.label} onChange={e => variant(v.id, { label: e.target.value })} /></label><details><summary aria-label="Hilfe: Bezeichnung">ⓘ</summary><p>Pflichtfeld. Name dieser kaufbaren Ausführung, maximal 120 Zeichen, z. B. Natur oder 30 g. Weitere Ausführungen als eigene Varianten anlegen.</p></details></div>
        <div className="product-field-help"><label>Nettoinhalt g (optional)<input type="number" min={1} value={v.size_grams ?? ''} onChange={e => variant(v.id, { size_grams: e.target.value ? Number(e.target.value) : null })} /></label><details><summary aria-label="Hilfe: Nettoinhalt g (optional)">ⓘ</summary><p>Optional. Tatsächlicher Nettoinhalt in ganzen Gramm, z. B. 30 für 30 g Matcha. Kein Versandgewicht und keine Bestellmenge; bei Zubehör ohne Grammangabe leer lassen.</p></details></div>
        <div className="product-field-help"><label>Bruttopreis EUR<input required type="text" inputMode="decimal" placeholder="0,00 €" value={v.price_input} aria-invalid={(submitted || !!v.price_input) && parseProductPrice(v.price_input) === null} aria-describedby={`price-${v.id}`} onChange={e => variant(v.id, { price_input: e.target.value })} /></label><details><summary aria-label="Hilfe: Bruttopreis EUR">ⓘ</summary><p>Pflichtfeld. Preis für eine Einheit einschließlich Umsatzsteuer in Euro, z. B. 14,99. Größer als 0, höchstens zwei Nachkommastellen. Die Steuerkategorie separat fachlich korrekt auswählen; sie ersetzt den Preis nicht.</p></details></div>
        {(submitted || !!v.price_input) && parseProductPrice(v.price_input) === null && <p id={`price-${v.id}`} role="alert">Bitte einen Preis größer als 0 mit höchstens zwei Nachkommastellen eingeben, zum Beispiel 14,99.</p>}
        <div className="product-field-help"><label>Steuerkategorie<select required value={v.tax_category} aria-invalid={submitted && !v.tax_category} aria-describedby={`tax-${v.id}`} onChange={e => variant(v.id, { tax_category: e.target.value as EditorVariant['tax_category'] })}><option value="" disabled>Steuerkategorie auswählen</option>{Object.entries(PRODUCT_TAX_CATEGORIES).map(([key, rate]) => <option key={key} value={key}>{TAX_CATEGORY_LABELS[key as keyof typeof TAX_CATEGORY_LABELS]} · {rate} %</option>)}</select></label><details><summary aria-label="Hilfe: Steuerkategorie">ⓘ</summary><p>Pflichtauswahl ohne Vorauswahl bei neuen Varianten. Fachlich bestätigte Einordnung wählen. Der angezeigte Satz stammt aus der bestehenden Steuerkonfiguration und bestimmt den Steueranteil im Bruttopreis. Bundles benötigen eine einheitliche, bestätigte Einordnung.</p></details></div>
        {submitted && !v.tax_category && <p id={`tax-${v.id}`} role="alert">Bitte eine Steuerkategorie auswählen.</p>}
        <div className="product-field-help"><label>Verfügbarkeit<select value={v.availability} onChange={e => variant(v.id, { availability: e.target.value as ProductVariantDraft['availability'] })}><option value="available">Verfügbar</option><option value="sold_out">AUSVERKAUFT</option></select></label><details><summary aria-label="Hilfe: Verfügbarkeit">ⓘ</summary><p>Verfügbar erlaubt den Kauf einer aktiven Variante eines veröffentlichten, abgeglichenen Produkts. AUSVERKAUFT sperrt neue Käufe. Diese Auswahl bucht keinen Bestand.</p></details></div>
        <div className="product-field-help"><label>Inventar (optional)<select value={v.inventory_item_id ?? ''} onChange={e => variant(v.id, { inventory_item_id: e.target.value || null })}><option value="">Nicht verknüpft</option>{inventory.map(i => <option key={i.id} value={i.id}>{i.name}{i.is_active ? '' : ' · INAKTIV'}</option>)}</select></label><details><summary aria-label="Hilfe: Inventar (optional)">ⓘ</summary><p>Optional. Vorhandenen Inventarartikel zuordnen. Der Bestand dient zur Information; es erfolgt keine automatische Bestandsbewegung.</p></details></div>
        {linked && <p>Bestand: {linked.current_quantity} {linked.unit}{!linked.is_active && ' · WARNUNG: Inventarartikel inaktiv'}. Keine automatische Bewegung.</p>}
        <div className="product-field-help"><label><input type="checkbox" checked={v.is_active} onChange={e => variant(v.id, { is_active: e.target.checked })} />Variante aktiv</label><details><summary aria-label="Hilfe: Variante aktiv">ⓘ</summary><p>Aktiv nimmt die Variante in den Stripe-Abgleich auf. Kaufen erfordert zusätzlich Verfügbarkeit und Veröffentlichung. Bestehende Varianten zum Ausblenden deaktivieren; ihre Identität bleibt erhalten.</p></details></div>
        {!editor.persisted.includes(v.id) && <button type="button" onClick={() => field('variants', d.variants.filter(x => x.id !== v.id))}>Ungespeicherte Variante entfernen</button>}
      </fieldset>; })}
      <p>Bestehende Matcha-Abos und Jahrespläne bleiben geschützt. Neue Produkte sind nur einmalig kaufbar. Bundles benötigen eine einzige fachlich bestätigte Steuerklassifikation.</p>
      <button type="button" disabled={busy} onClick={() => field('variants', [...d.variants, newEditorVariant()])}>VARIANTE HINZUFÜGEN</button>
      {editor.wasPublished && <label className="product-publish-confirm"><input type="checkbox" required checked={unpublishAcknowledged} onChange={e => setUnpublishAcknowledged(e.target.checked)} />Ich bestätige: Mit dem Speichern wird dieses Produkt zum Entwurf und vorübergehend nicht kaufbar.</label>}
      <button type="submit" disabled={busy || !d.variants.length}>{busy ? 'Bitte warten …' : 'ENTWURF SPEICHERN'}</button>
      <button type="button" disabled={busy} onClick={() => setEditor(null)}>Schließen</button>
    </form>}
    <details className="product-workflow-help"><summary>ⓘ Speichern, Stripe-Abgleich und Veröffentlichung</summary><p>Speichern setzt auch veröffentlichte Produkte auf Entwurf. Danach mit PRÜFEN & VERÖFFENTLICHEN den Abgleich, die Prüfung und die Veröffentlichung starten. Der Abgleich legt ein Stripe-Produkt und Preise für aktive Varianten an oder verwendet vorhandene Zuordnungen. Ein erfolgreicher Abgleich allein veröffentlicht nichts. Preisänderungen erhalten neue Stripe-Preise; bisherige Preise bleiben bestehen. Bei Fehlern die Stripe-Spalte prüfen und den Abgleich erneut versuchen.</p></details>
    <div className="portal-table-wrap"><table className="portal-table"><thead><tr>{['Produkt', 'Typ', 'Varianten / Preis', 'Status', 'Stripe', 'Verfügbarkeit', 'Inventar', 'Aktualisiert', 'Aktionen'].map(h => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{products.map(p => { const amounts = p.product_variants.map(v => v.price_gross_cents).filter(n => typeof n === 'number'); return <tr key={p.id}>
        <td>{p.name}<br /><small>{p.slug}</small></td><td>{p.product_type}</td><td>{p.product_variants.length} · {amounts.length ? `${euros(Math.min(...amounts))} – ${euros(Math.max(...amounts))}` : 'Kein Preis'}</td>
        <td>{unresolvedProduct === p.id ? 'Status unklar — bitte aktualisieren' : state(p)}</td><td>{({ pending: 'Abgleich ausstehend', synced: 'Stripe-Abgleich erfolgreich', error: 'Abgleich fehlgeschlagen' } as Record<string, string>)[p.stripe_sync_status] ?? p.stripe_sync_status}{p.stripe_sync_revision === 0 && ' · Legacy-Übergang'}{p.stripe_sync_error && <p>{p.stripe_sync_error}</p>}</td>
        <td>{p.product_variants.some(v => v.is_active && v.availability === 'available') ? 'Verfügbar' : 'AUSVERKAUFT'}</td>
        <td>{p.product_variants.filter(v => v.inventory_item_id).length} verknüpft</td><td>{new Date(p.updated_at).toLocaleString('de-DE')}</td>
        <td>{!p.archived_at && <><button type="button" disabled={busy || !writable} onClick={() => edit(p)}>Bearbeiten</button>
          {writable && !p.is_active && p.slug !== 'metal-case' && <button type="button" disabled={busy || editor !== null || unresolvedProduct === p.id} onClick={() => void publish(p)}>PRÜFEN &amp; VERÖFFENTLICHEN</button>}
          {writable && <button type="button" disabled={busy} onClick={() => void act('archive', p)}>ARCHIVIEREN</button>}</>}</td></tr>; })}</tbody></table></div>
  </section>;
}

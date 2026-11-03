/** Retains safe request metadata across worker restarts, without response HTML or cookies.
 * @param {{query: Function}} client Migration connection.
 * @returns {Promise<void>}
 */
export async function up(client) {
    try { await client.query('ALTER TABLE catalog_item_discovery ADD COLUMN last_request LONGTEXT CHECK (last_request IS NULL OR JSON_VALID(last_request))'); }
    catch (error) { if (error?.code !== 'ER_DUP_FIELDNAME') throw error; }
}

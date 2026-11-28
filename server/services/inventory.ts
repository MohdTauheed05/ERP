import type Database from 'better-sqlite3';
import { nowISO, roundMoney, roundQty, todayISO } from '../utils/helpers.ts';
import { createNotification } from '../middleware/auth.ts';

export interface StockMovementParams {
  postingDate?: string;
  docType: string;
  docId: number;
  docNumber: string;
  itemId: number;
  warehouseId: number;
  tankId?: number | null;
  batchNumber?: string;
  inwardQty?: number;
  outwardQty?: number;
  unitCost?: number;
  supplierId?: number | null;
  mfgDate?: string;
  expiryDate?: string;
  qcStatus?: string;
  isOnHold?: boolean;
  remarks?: string;
  userId?: number | null;
  allowNegativeOverride?: boolean;
}

export function getItemWarehouseBalance(db: Database.Database, itemId: number, warehouseId: number): { qty: number; avgCost: number; value: number } {
  const last = db
    .prepare(
      `SELECT closing_qty, unit_cost, stock_value
       FROM stock_ledger
       WHERE item_id = ? AND warehouse_id = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(itemId, warehouseId) as { closing_qty: number; unit_cost: number; stock_value: number } | undefined;

  if (!last) return { qty: 0, avgCost: 0, value: 0 };
  return {
    qty: roundQty(last.closing_qty),
    avgCost: roundMoney(last.unit_cost),
    value: roundMoney(last.stock_value),
  };
}

export function getTotalItemStock(db: Database.Database, itemId: number): number {
  const rows = db
    .prepare(
      `SELECT sl.warehouse_id, sl.closing_qty
       FROM stock_ledger sl
       INNER JOIN (
         SELECT warehouse_id, MAX(id) as max_id
         FROM stock_ledger
         WHERE item_id = ?
         GROUP BY warehouse_id
       ) latest ON latest.max_id = sl.id`
    )
    .all(itemId) as { warehouse_id: number; closing_qty: number }[];
  return roundQty(rows.reduce((sum, r) => sum + r.closing_qty, 0));
}

export function postStockMovement(db: Database.Database, params: StockMovementParams): { batchId: number | null; ledgerId: number; closingQty: number; unitCost: number } {
  const item = db
    .prepare('SELECT id, item_code, name, standard_cost, average_cost, valuation_method, reorder_level, batch_tracking FROM items WHERE id = ?')
    .get(params.itemId) as
    | {
        id: number;
        item_code: string;
        name: string;
        standard_cost: number;
        average_cost: number;
        valuation_method: string;
        reorder_level: number;
        batch_tracking: number;
      }
    | undefined;

  if (!item) throw new Error(`Item #${params.itemId} not found`);

  const inward = roundQty(params.inwardQty ?? 0);
  const outward = roundQty(params.outwardQty ?? 0);
  if (inward < 0 || outward < 0) throw new Error('Stock movement quantities cannot be negative');
  if (inward === 0 && outward === 0) throw new Error('Stock movement must have inward or outward quantity');

  const settingAllowNeg = db.prepare("SELECT value FROM system_settings WHERE key = 'allow_negative_stock'").get() as { value: string } | undefined;
  const negativeAllowed = params.allowNegativeOverride || settingAllowNeg?.value === 'true';

  // Validate and prepare Storage Tank update (if tankId provided)
  const tankId = params.tankId ? Number(params.tankId) : null;
  let tank:
    | {
        id: number;
        tank_code: string;
        name: string;
        warehouse_id: number;
        capacity_qty: number;
        current_qty: number;
        assigned_item_id: number | null;
        is_active: number;
      }
    | undefined;

  if (tankId) {
    tank = db
      .prepare('SELECT id, tank_code, name, warehouse_id, capacity_qty, current_qty, assigned_item_id, is_active FROM storage_tanks WHERE id = ?')
      .get(tankId) as typeof tank;
    if (!tank) throw new Error(`Storage tank #${tankId} not found`);
    if (!tank.is_active) throw new Error(`Storage tank ${tank.tank_code} is inactive`);
    if (tank.warehouse_id !== params.warehouseId) {
      throw new Error(`Storage tank ${tank.tank_code} does not belong to warehouse #${params.warehouseId}`);
    }
    if (inward > 0) {
      if (tank.current_qty > 0 && tank.assigned_item_id && tank.assigned_item_id !== params.itemId) {
        const prevItem = db.prepare('SELECT item_code, name FROM items WHERE id = ?').get(tank.assigned_item_id) as { item_code: string; name: string } | undefined;
        throw new Error(
          `Tank ${tank.tank_code} currently holds ${tank.current_qty} of ${prevItem ? `${prevItem.item_code} (${prevItem.name})` : `item #${tank.assigned_item_id}`}. Drain or transfer tank before mixing grades.`
        );
      }
      if (tank.capacity_qty > 0 && roundQty(tank.current_qty + inward) > tank.capacity_qty) {
        throw new Error(
          `Tank ${tank.tank_code} capacity exceeded. Capacity: ${tank.capacity_qty}, Current: ${tank.current_qty}, Inward: ${inward}`
        );
      }
    }
    if (outward > 0) {
      if (tank.current_qty > 0 && tank.assigned_item_id && tank.assigned_item_id !== params.itemId) {
        throw new Error(`Tank ${tank.tank_code} does not contain ${item.item_code} (${item.name}).`);
      }
      if (tank.current_qty < outward && !negativeAllowed) {
        throw new Error(`Insufficient stock in tank ${tank.tank_code}. Available: ${tank.current_qty}, Requested outward: ${outward}`);
      }
    }
  }

  const current = getItemWarehouseBalance(db, params.itemId, params.warehouseId);
  const openingQty = current.qty;
  const closingQty = roundQty(openingQty + inward - outward);

  if (closingQty < 0 && !negativeAllowed) {
    throw new Error(
      `Insufficient stock for ${item.item_code} (${item.name}) in warehouse #${params.warehouseId}. Available: ${openingQty}, Requested outward: ${outward}`
    );
  }

  let unitCost = params.unitCost !== undefined && params.unitCost > 0 ? roundMoney(params.unitCost) : current.avgCost || item.average_cost || item.standard_cost;
  let newStockValue = current.value;
  const valMethod = item.valuation_method || 'Moving Average';

  if (inward > 0) {
    newStockValue = roundMoney(current.value + inward * unitCost);
    if (closingQty > 0) {
      unitCost = roundMoney(newStockValue / closingQty);
    }
  } else if (outward > 0) {
    // Moving average or FIFO cost pull
    if (valMethod === 'FIFO') {
      const oldestBatch = db
        .prepare(
          `SELECT unit_cost FROM stock_batches
           WHERE item_id = ? AND warehouse_id = ? AND available_qty > 0
           ORDER BY id ASC LIMIT 1`
        )
        .get(params.itemId, params.warehouseId) as { unit_cost: number } | undefined;
      if (oldestBatch && oldestBatch.unit_cost > 0) {
        unitCost = roundMoney(oldestBatch.unit_cost);
      }
    } else {
      unitCost = current.avgCost > 0 ? current.avgCost : item.average_cost || item.standard_cost;
    }
    newStockValue = roundMoney(Math.max(0, current.value - outward * unitCost));
  }

  // Batch Management
  let batchId: number | null = null;
  let batchNumber = params.batchNumber?.trim() || '';

  if (inward > 0) {
    if (!batchNumber && item.batch_tracking) {
      batchNumber = `B-${item.item_code}-${Date.now().toString().slice(-6)}`;
    }
    if (batchNumber) {
      const existingBatch = db
        .prepare('SELECT id, available_qty FROM stock_batches WHERE batch_number = ?')
        .get(batchNumber) as { id: number; available_qty: number } | undefined;
      if (existingBatch) {
        db.prepare('UPDATE stock_batches SET available_qty = ROUND(available_qty + ?, 4), tank_id = COALESCE(?, tank_id) WHERE id = ?').run(
          inward,
          tankId,
          existingBatch.id
        );
        batchId = existingBatch.id;
      } else {
        const res = db
          .prepare(
            `INSERT INTO stock_batches (batch_number, item_id, warehouse_id, tank_id, source_type, source_doc_id, source_doc_number, supplier_id, mfg_date, expiry_date, initial_qty, available_qty, reserved_qty, unit_cost, qc_status, is_on_hold, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
          )
          .run(
            batchNumber,
            params.itemId,
            params.warehouseId,
            tankId,
            params.docType,
            params.docId,
            params.docNumber,
            params.supplierId ?? null,
            params.mfgDate ?? '',
            params.expiryDate ?? '',
            inward,
            inward,
            params.unitCost ?? unitCost,
            params.qcStatus ?? 'Released',
            params.isOnHold ? 1 : 0,
            nowISO()
          );
        batchId = Number(res.lastInsertRowid);
      }
    }
  } else if (outward > 0 && batchNumber) {
    const batch = db
      .prepare('SELECT id, available_qty, is_on_hold, qc_status FROM stock_batches WHERE batch_number = ? AND item_id = ?')
      .get(batchNumber, params.itemId) as { id: number; available_qty: number; is_on_hold: number; qc_status: string } | undefined;

    if (batch) {
      if (batch.is_on_hold === 1 && !['StockAdjustment', 'PurchaseReturn'].includes(params.docType)) {
        throw new Error(`Batch ${batchNumber} is on Quality Hold and cannot be issued or dispatched.`);
      }
      if (batch.available_qty < outward && !negativeAllowed) {
        throw new Error(`Insufficient quantity in batch ${batchNumber}. Available: ${batch.available_qty}, Requested: ${outward}`);
      }
      db.prepare('UPDATE stock_batches SET available_qty = ROUND(available_qty - ?, 4) WHERE id = ?').run(outward, batch.id);
      batchId = batch.id;
    }
  } else if (outward > 0 && !batchNumber) {
    // Auto-allocate from oldest available released batches (FIFO), preferring matching tank if specified
    let remaining = outward;
    const batches = db
      .prepare(
        `SELECT id, batch_number, available_qty FROM stock_batches
         WHERE item_id = ? AND warehouse_id = ? AND available_qty > 0 AND is_on_hold = 0
           AND (CAST(? AS BIGINT) IS NULL OR tank_id = ? OR tank_id IS NULL)
         ORDER BY CASE WHEN CAST(? AS BIGINT) IS NOT NULL AND tank_id = ? THEN 0 ELSE 1 END, id ASC`
      )
      .all(params.itemId, params.warehouseId, tankId, tankId, tankId, tankId) as { id: number; batch_number: string; available_qty: number }[];
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, b.available_qty);
      db.prepare('UPDATE stock_batches SET available_qty = ROUND(available_qty - ?, 4) WHERE id = ?').run(take, b.id);
      if (!batchId) {
        batchId = b.id;
        batchNumber = b.batch_number;
      }
      remaining = roundQty(remaining - take);
    }
  }

  // Update Storage Tank level
  if (tankId && tank) {
    if (inward > 0) {
      const nextTankQty = roundQty(tank.current_qty + inward);
      db.prepare('UPDATE storage_tanks SET current_qty = ?, assigned_item_id = ? WHERE id = ?').run(nextTankQty, params.itemId, tankId);
    } else if (outward > 0) {
      const nextTankQty = roundQty(Math.max(0, tank.current_qty - outward));
      db.prepare('UPDATE storage_tanks SET current_qty = ? WHERE id = ?').run(nextTankQty, tankId);
    }
  }

  // Insert immutable Stock Ledger entry
  const ledgerRes = db
    .prepare(
      `INSERT INTO stock_ledger (posting_date, doc_type, doc_id, doc_number, item_id, warehouse_id, tank_id, batch_id, batch_number, opening_qty, inward_qty, outward_qty, closing_qty, unit_cost, stock_value, valuation_method, remarks, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.postingDate || todayISO(),
      params.docType,
      params.docId,
      params.docNumber,
      params.itemId,
      params.warehouseId,
      tankId,
      batchId,
      batchNumber,
      openingQty,
      inward,
      outward,
      closingQty,
      unitCost,
      newStockValue,
      valMethod,
      params.remarks ?? '',
      params.userId ?? null,
      nowISO()
    );

  // Update item average cost and last purchase price
  if (inward > 0) {
    db.prepare('UPDATE items SET average_cost = ?, last_purchase_price = CASE WHEN ? IN (\'PurchaseReceipt\', \'PurchaseInvoice\') THEN ? ELSE last_purchase_price END, updated_at = ? WHERE id = ?').run(
      unitCost,
      params.docType,
      params.unitCost ?? unitCost,
      nowISO(),
      params.itemId
    );
  }

  // Check Reorder Alert
  const totalStock = getTotalItemStock(db, params.itemId);
  if (item.reorder_level > 0 && totalStock <= item.reorder_level) {
    createNotification(db, {
      type: 'low_stock',
      title: `Low Stock Alert: ${item.item_code}`,
      message: `${item.name} stock (${totalStock}) is at or below reorder level (${item.reorder_level}).`,
      docType: 'Item',
      docId: item.id,
    });
  }

  return {
    batchId,
    ledgerId: Number(ledgerRes.lastInsertRowid),
    closingQty,
    unitCost,
  };
}

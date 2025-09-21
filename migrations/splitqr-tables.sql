-- ================================================================
-- MIGRACIÓN SPLITQR - NUEVAS TABLAS PARA FUNCIONALIDAD DE QR DIVIDIDO
-- Archivo: splitqr-tables.sql
-- ================================================================

-- 1. Tabla para gestionar cuentas de mesa (cada mesa puede tener una cuenta activa)
CREATE TABLE IF NOT EXISTS cuentas_mesa (
    id SERIAL PRIMARY KEY,
    mesa_id INTEGER NOT NULL REFERENCES mesas(id) ON DELETE CASCADE,
    qr_code_id VARCHAR(100) UNIQUE NOT NULL, -- ID único para generar URL del QR
    fecha_apertura TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_cierre TIMESTAMP NULL,
    estado VARCHAR(20) DEFAULT 'abierta', -- 'abierta', 'pagada', 'cerrada'
    subtotal DECIMAL(10,2) DEFAULT 0.00,
    descuento DECIMAL(10,2) DEFAULT 0.00,
    total DECIMAL(10,2) DEFAULT 0.00,
    pagado DECIMAL(10,2) DEFAULT 0.00,
    pendiente DECIMAL(10,2) DEFAULT 0.00,
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabla para items/productos agregados a la cuenta de una mesa
CREATE TABLE IF NOT EXISTS items_cuenta (
    id SERIAL PRIMARY KEY,
    cuenta_mesa_id INTEGER NOT NULL REFERENCES cuentas_mesa(id) ON DELETE CASCADE,
    producto_id INTEGER NULL, -- Referencia a tabla de productos del menú
    producto_nombre VARCHAR(255) NOT NULL, -- Nombre del producto (backup si se elimina del menú)
    producto_descripcion TEXT,
    categoria_nombre VARCHAR(100),
    precio_unitario DECIMAL(10,2) NOT NULL,
    cantidad INTEGER DEFAULT 1,
    precio_total DECIMAL(10,2) NOT NULL, -- precio_unitario * cantidad
    agregado_por VARCHAR(100) DEFAULT 'dashboard', -- 'dashboard', 'mesero', etc.
    fecha_agregado TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    pagado BOOLEAN DEFAULT FALSE, -- Si este item específico ya fue pagado
    pagado_por VARCHAR(255) NULL, -- Nombre de quien pagó este item
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Tabla para registrar pagos parciales (cuando los comensales pagan por partes)
CREATE TABLE IF NOT EXISTS pagos_parciales (
    id SERIAL PRIMARY KEY,
    cuenta_mesa_id INTEGER NOT NULL REFERENCES cuentas_mesa(id) ON DELETE CASCADE,
    session_id VARCHAR(100) NOT NULL, -- ID de sesión de pago único
    cliente_nombre VARCHAR(255) NOT NULL,
    cliente_telefono VARCHAR(20),
    monto DECIMAL(10,2) NOT NULL,
    metodo_pago VARCHAR(50) DEFAULT 'tarjeta', -- 'tarjeta', 'bizum', 'efectivo'
    tipo_division VARCHAR(20) DEFAULT 'igual', -- 'igual', 'items'
    items_pagados TEXT, -- JSON con IDs de items pagados (para división por items)
    estado VARCHAR(20) DEFAULT 'pendiente', -- 'pendiente', 'completado', 'fallido'
    fecha_pago TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    transaction_id VARCHAR(100),
    payment_gateway_response TEXT, -- Respuesta del gateway de pago
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Índices para optimizar consultas
CREATE INDEX IF NOT EXISTS idx_cuentas_mesa_mesa_id ON cuentas_mesa(mesa_id);
CREATE INDEX IF NOT EXISTS idx_cuentas_mesa_qr_code ON cuentas_mesa(qr_code_id);
CREATE INDEX IF NOT EXISTS idx_cuentas_mesa_estado ON cuentas_mesa(estado);
CREATE INDEX IF NOT EXISTS idx_items_cuenta_mesa_id ON items_cuenta(cuenta_mesa_id);
CREATE INDEX IF NOT EXISTS idx_items_cuenta_pagado ON items_cuenta(pagado);
CREATE INDEX IF NOT EXISTS idx_pagos_parciales_cuenta_id ON pagos_parciales(cuenta_mesa_id);
CREATE INDEX IF NOT EXISTS idx_pagos_parciales_session ON pagos_parciales(session_id);
CREATE INDEX IF NOT EXISTS idx_pagos_parciales_estado ON pagos_parciales(estado);

-- 5. Triggers para mantener totales actualizados
CREATE OR REPLACE FUNCTION actualizar_totales_cuenta()
RETURNS TRIGGER AS $$
BEGIN
    -- Actualizar totales de la cuenta cuando se agreguen/modifiquen items
    UPDATE cuentas_mesa
    SET
        subtotal = (
            SELECT COALESCE(SUM(precio_total), 0)
            FROM items_cuenta
            WHERE cuenta_mesa_id = NEW.cuenta_mesa_id
        ),
        total = (
            SELECT COALESCE(SUM(precio_total), 0)
            FROM items_cuenta
            WHERE cuenta_mesa_id = NEW.cuenta_mesa_id
        ) - descuento,
        pendiente = (
            SELECT COALESCE(SUM(precio_total), 0)
            FROM items_cuenta
            WHERE cuenta_mesa_id = NEW.cuenta_mesa_id
        ) - descuento - pagado,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.cuenta_mesa_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar trigger a items_cuenta
DROP TRIGGER IF EXISTS trigger_actualizar_totales ON items_cuenta;
CREATE TRIGGER trigger_actualizar_totales
    AFTER INSERT OR UPDATE OR DELETE ON items_cuenta
    FOR EACH ROW EXECUTE FUNCTION actualizar_totales_cuenta();

-- 6. Trigger para actualizar pagado cuando se registren pagos parciales
CREATE OR REPLACE FUNCTION actualizar_pagado_cuenta()
RETURNS TRIGGER AS $$
BEGIN
    -- Actualizar monto pagado cuando se complete un pago parcial
    IF NEW.estado = 'completado' THEN
        UPDATE cuentas_mesa
        SET
            pagado = (
                SELECT COALESCE(SUM(monto), 0)
                FROM pagos_parciales
                WHERE cuenta_mesa_id = NEW.cuenta_mesa_id
                AND estado = 'completado'
            ),
            pendiente = total - (
                SELECT COALESCE(SUM(monto), 0)
                FROM pagos_parciales
                WHERE cuenta_mesa_id = NEW.cuenta_mesa_id
                AND estado = 'completado'
            ),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.cuenta_mesa_id;

        -- Si la cuenta está completamente pagada, cambiar estado
        UPDATE cuentas_mesa
        SET estado = 'pagada'
        WHERE id = NEW.cuenta_mesa_id
        AND pendiente <= 0.01; -- Tolerancia para centavos
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar trigger a pagos_parciales
DROP TRIGGER IF EXISTS trigger_actualizar_pagado ON pagos_parciales;
CREATE TRIGGER trigger_actualizar_pagado
    AFTER INSERT OR UPDATE ON pagos_parciales
    FOR EACH ROW EXECUTE FUNCTION actualizar_pagado_cuenta();

-- 7. Función helper para generar QR code ID único
CREATE OR REPLACE FUNCTION generar_qr_id()
RETURNS VARCHAR(100) AS $$
DECLARE
    nuevo_id VARCHAR(100);
    existe BOOLEAN;
BEGIN
    LOOP
        -- Generar ID único: MESA + timestamp + random
        nuevo_id := 'QR' || LPAD(EXTRACT(epoch FROM NOW())::text, 10, '0') || LPAD((RANDOM() * 9999)::int::text, 4, '0');

        -- Verificar que no existe
        SELECT EXISTS(SELECT 1 FROM cuentas_mesa WHERE qr_code_id = nuevo_id) INTO existe;

        EXIT WHEN NOT existe;
    END LOOP;

    RETURN nuevo_id;
END;
$$ LANGUAGE plpgsql;

-- 8. Datos de ejemplo para testing (opcional)
-- INSERT INTO cuentas_mesa (mesa_id, qr_code_id, estado)
-- VALUES (1, generar_qr_id(), 'abierta');

COMMENT ON TABLE cuentas_mesa IS 'Gestiona las cuentas abiertas por mesa para SplitQR';
COMMENT ON TABLE items_cuenta IS 'Items/productos agregados a cada cuenta de mesa';
COMMENT ON TABLE pagos_parciales IS 'Registro de pagos divididos por mesa';
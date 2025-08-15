// init-database.js
// Script para inicializar la base de datos en Railway

const { Pool } = require('pg');
require('dotenv').config();

// Usar DATABASE_URL de Railway o variables individuales
const connectionString = process.env.DATABASE_URL;
const pool = connectionString 
  ? new Pool({ connectionString, ssl: { rejectUnauthorized: false } })
  : new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'gastrobot',
      password: process.env.DB_PASSWORD || 'password',
      port: process.env.DB_PORT || 5432,
    });

async function initDatabase() {
  console.log('🚀 Iniciando creación de base de datos...');
  
  try {
    // Crear todas las tablas
    await pool.query(`
      -- ==============================================
      -- TABLA: RESTAURANTE
      -- ==============================================
      CREATE TABLE IF NOT EXISTS restaurante (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL DEFAULT 'Mi Restaurante',
        direccion TEXT DEFAULT 'Calle Principal 123, Barcelona',
        telefono VARCHAR(20) DEFAULT '+34 900 123 456',
        web VARCHAR(100) DEFAULT 'www.mirestaurante.com',
        email VARCHAR(100) DEFAULT 'info@mirestaurante.com',
        logo_url TEXT,
        descripcion TEXT DEFAULT 'Cocina mediterránea moderna',
        coordenadas_lat DECIMAL(10, 8),
        coordenadas_lng DECIMAL(11, 8),
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      );

      -- ==============================================
      -- TABLA: MESAS
      -- ==============================================
      CREATE TABLE IF NOT EXISTS mesas (
        id SERIAL PRIMARY KEY,
        numero_mesa VARCHAR(10) UNIQUE NOT NULL,
        capacidad INTEGER NOT NULL CHECK (capacidad > 0),
        capacidad_maxima INTEGER,
        zona VARCHAR(50) DEFAULT 'interior',
        ubicacion VARCHAR(100),
        unible BOOLEAN DEFAULT false,
        unible_con VARCHAR(50),
        caracteristicas TEXT[],
        activa BOOLEAN DEFAULT true,
        creada_en TIMESTAMP DEFAULT NOW()
      );

      -- ==============================================
      -- TABLA: CLIENTES
      -- ==============================================
      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        telefono VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(100),
        fecha_nacimiento DATE,
        preferencias TEXT,
        alergias TEXT[],
        notas_internas TEXT,
        vip BOOLEAN DEFAULT false,
        bloqueado BOOLEAN DEFAULT false,
        motivo_bloqueo TEXT,
        idioma_preferido VARCHAR(5) DEFAULT 'es',
        acepta_marketing BOOLEAN DEFAULT true,
        total_reservas INTEGER DEFAULT 0,
        total_cancelaciones INTEGER DEFAULT 0,
        total_no_shows INTEGER DEFAULT 0,
        ultima_visita DATE,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      );

      -- ==============================================
      -- TABLA: RESERVAS
      -- ==============================================
      CREATE TABLE IF NOT EXISTS reservas (
        id SERIAL PRIMARY KEY,
        codigo_reserva VARCHAR(10) UNIQUE,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
        mesa_id INTEGER REFERENCES mesas(id),
        fecha DATE NOT NULL,
        hora TIME NOT NULL,
        personas INTEGER NOT NULL CHECK (personas > 0),
        duracion INTEGER DEFAULT 120,
        notas TEXT,
        notas_alergias TEXT,
        celebracion VARCHAR(50),
        menu_especial VARCHAR(50),
        estado VARCHAR(20) DEFAULT 'confirmada',
        origen VARCHAR(20) DEFAULT 'bot',
        confirmada_por_cliente BOOLEAN DEFAULT false,
        recordatorio_enviado BOOLEAN DEFAULT false,
        motivo_cancelacion TEXT,
        cancelada_por VARCHAR(20),
        llegada_registrada TIMESTAMP,
        salida_registrada TIMESTAMP,
        consumo_total DECIMAL(10,2),
        valoracion INTEGER CHECK (valoracion >= 1 AND valoracion <= 5),
        comentario_valoracion TEXT,
        creada_en TIMESTAMP DEFAULT NOW(),
        modificada_en TIMESTAMP,
        cancelada_en TIMESTAMP
      );

      -- ==============================================
      -- TABLA: HORARIOS
      -- ==============================================
      CREATE TABLE IF NOT EXISTS horarios (
        id SERIAL PRIMARY KEY,
        dia_semana INTEGER NOT NULL CHECK (dia_semana >= 0 AND dia_semana <= 6),
        apertura TIME,
        cierre TIME,
        turno_comida_inicio TIME,
        turno_comida_fin TIME,
        turno_cena_inicio TIME,
        turno_cena_fin TIME,
        cerrado BOOLEAN DEFAULT false,
        capacidad_reducida BOOLEAN DEFAULT false,
        porcentaje_capacidad INTEGER DEFAULT 100,
        UNIQUE(dia_semana)
      );

      -- ==============================================
      -- TABLA: EXCEPCIONES DE HORARIO
      -- ==============================================
      CREATE TABLE IF NOT EXISTS excepciones_horario (
        id SERIAL PRIMARY KEY,
        fecha DATE UNIQUE NOT NULL,
        apertura TIME,
        cierre TIME,
        turno_comida_inicio TIME,
        turno_comida_fin TIME,
        turno_cena_inicio TIME,
        turno_cena_fin TIME,
        cerrado BOOLEAN DEFAULT false,
        motivo VARCHAR(100),
        capacidad_reducida BOOLEAN DEFAULT false,
        porcentaje_capacidad INTEGER DEFAULT 100,
        creado_en TIMESTAMP DEFAULT NOW()
      );

      -- ==============================================
      -- TABLA: CATEGORÍAS DEL MENÚ
      -- ==============================================
      CREATE TABLE IF NOT EXISTS categorias_menu (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(50) NOT NULL,
        nombre_en VARCHAR(50),
        descripcion TEXT,
        descripcion_en TEXT,
        orden INTEGER DEFAULT 0,
        visible BOOLEAN DEFAULT true,
        icono VARCHAR(50),
        horario_disponible VARCHAR(20) DEFAULT 'todo',
        creado_en TIMESTAMP DEFAULT NOW()
      );

      -- ==============================================
      -- TABLA: PLATOS
      -- ==============================================
      CREATE TABLE IF NOT EXISTS platos (
        id SERIAL PRIMARY KEY,
        categoria_id INTEGER REFERENCES categorias_menu(id) ON DELETE CASCADE,
        nombre VARCHAR(100) NOT NULL,
        nombre_en VARCHAR(100),
        descripcion TEXT,
        descripcion_en TEXT,
        precio DECIMAL(10,2) NOT NULL,
        precio_racion_media DECIMAL(10,2),
        tiempo_preparacion INTEGER,
        calorias INTEGER,
        picante INTEGER CHECK (picante >= 0 AND picante <= 3),
        vegetariano BOOLEAN DEFAULT false,
        vegano BOOLEAN DEFAULT false,
        sin_gluten BOOLEAN DEFAULT false,
        sin_lactosa BOOLEAN DEFAULT false,
        imagen_url TEXT,
        disponible BOOLEAN DEFAULT true,
        agotado_hoy BOOLEAN DEFAULT false,
        recomendado BOOLEAN DEFAULT false,
        nuevo BOOLEAN DEFAULT false,
        maridaje_vino TEXT,
        orden INTEGER DEFAULT 0,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      );

      -- ==============================================
      -- TABLA: ALÉRGENOS
      -- ==============================================
      CREATE TABLE IF NOT EXISTS alergenos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(50) UNIQUE NOT NULL,
        icono VARCHAR(50),
        descripcion TEXT
      );

      -- ==============================================
      -- TABLA: RELACIÓN PLATOS-ALÉRGENOS
      -- ==============================================
      CREATE TABLE IF NOT EXISTS platos_alergenos (
        plato_id INTEGER REFERENCES platos(id) ON DELETE CASCADE,
        alergeno_id INTEGER REFERENCES alergenos(id) ON DELETE CASCADE,
        PRIMARY KEY (plato_id, alergeno_id)
      );

      -- ==============================================
      -- TABLA: POLÍTICAS
      -- ==============================================
      CREATE TABLE IF NOT EXISTS politicas (
        id SERIAL PRIMARY KEY,
        cancelacion_horas INTEGER DEFAULT 24,
        cancelacion_mensaje TEXT DEFAULT 'Las cancelaciones deben realizarse con 24 horas de antelación',
        no_show_penalizacion BOOLEAN DEFAULT false,
        no_show_cantidad DECIMAL(10,2),
        no_show_bloqueo_tras INTEGER DEFAULT 3,
        tiempo_mesa_minutos INTEGER DEFAULT 120,
        tiempo_mesa_mensaje TEXT,
        anticipo_requerido BOOLEAN DEFAULT false,
        anticipo_cantidad DECIMAL(10,2),
        anticipo_porcentaje INTEGER,
        anticipo_grupos_desde INTEGER DEFAULT 8,
        confirmacion_requerida BOOLEAN DEFAULT true,
        confirmacion_horas_antes INTEGER DEFAULT 4,
        niños_permitidos BOOLEAN DEFAULT true,
        niños_menu_especial BOOLEAN DEFAULT true,
        niños_descuento INTEGER DEFAULT 0,
        mascotas_permitidas BOOLEAN DEFAULT false,
        mascotas_solo_terraza BOOLEAN DEFAULT true,
        dress_code VARCHAR(100),
        fumadores_terraza BOOLEAN DEFAULT true,
        edad_minima_reserva INTEGER DEFAULT 18,
        reserva_maxima_personas INTEGER DEFAULT 20,
        reserva_maxima_dias_anticipacion INTEGER DEFAULT 60,
        info_alergias TEXT DEFAULT 'Por favor, indique cualquier alergia o intolerancia alimentaria',
        mensaje_bienvenida TEXT,
        mensaje_confirmacion TEXT,
        mensaje_recordatorio TEXT,
        mensaje_agradecimiento TEXT,
        actualizado_en TIMESTAMP DEFAULT NOW()
      );

      -- ==============================================
      -- TABLA: PROMOCIONES Y EVENTOS
      -- ==============================================
      CREATE TABLE IF NOT EXISTS promociones (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        nombre_en VARCHAR(100),
        descripcion TEXT,
        descripcion_en TEXT,
        tipo VARCHAR(30),
        fecha_inicio DATE,
        fecha_fin DATE,
        hora_inicio TIME,
        hora_fin TIME,
        dias_semana INTEGER[],
        descuento_porcentaje INTEGER,
        descuento_cantidad DECIMAL(10,2),
        precio_menu_especial DECIMAL(10,2),
        condiciones TEXT,
        codigo_promocional VARCHAR(20),
        requiere_reserva BOOLEAN DEFAULT false,
        plazas_limitadas INTEGER,
        plazas_ocupadas INTEGER DEFAULT 0,
        imagen_url TEXT,
        activo BOOLEAN DEFAULT true,
        creado_en TIMESTAMP DEFAULT NOW()
      );

      -- ==============================================
      -- TABLA: LISTA DE ESPERA
      -- ==============================================
      CREATE TABLE IF NOT EXISTS lista_espera (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        telefono VARCHAR(20) NOT NULL,
        email VARCHAR(100),
        fecha DATE NOT NULL,
        hora_preferida TIME,
        hora_desde TIME,
        hora_hasta TIME,
        personas INTEGER NOT NULL,
        flexible BOOLEAN DEFAULT false,
        zona_preferida VARCHAR(50),
        notas TEXT,
        prioridad INTEGER DEFAULT 2,
        estado VARCHAR(20) DEFAULT 'esperando',
        notificado_en TIMESTAMP,
        expira_en TIMESTAMP,
        reserva_id INTEGER REFERENCES reservas(id),
        creada_en TIMESTAMP DEFAULT NOW()
      );

      -- ==============================================
      -- TABLA: HISTORIAL DE CAMBIOS
      -- ==============================================
      CREATE TABLE IF NOT EXISTS historial_cambios (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(50) NOT NULL,
        entidad VARCHAR(30),
        entidad_id INTEGER,
        datos_antes JSONB,
        datos_despues JSONB,
        cambios JSONB,
        usuario VARCHAR(50) DEFAULT 'sistema',
        ip_address INET,
        user_agent TEXT,
        reversible BOOLEAN DEFAULT true,
        revertido BOOLEAN DEFAULT false,
        revertido_por INTEGER REFERENCES historial_cambios(id),
        fecha TIMESTAMP DEFAULT NOW()
      );

      -- ==============================================
      -- ÍNDICES PARA OPTIMIZACIÓN
      -- ==============================================
      CREATE INDEX IF NOT EXISTS idx_reservas_fecha ON reservas(fecha);
      CREATE INDEX IF NOT EXISTS idx_reservas_estado ON reservas(estado);
      CREATE INDEX IF NOT EXISTS idx_reservas_cliente ON reservas(cliente_id);
      CREATE INDEX IF NOT EXISTS idx_reservas_fecha_hora ON reservas(fecha, hora);
      CREATE INDEX IF NOT EXISTS idx_lista_espera_fecha ON lista_espera(fecha);
      CREATE INDEX IF NOT EXISTS idx_lista_espera_estado ON lista_espera(estado);
      CREATE INDEX IF NOT EXISTS idx_historial_fecha ON historial_cambios(fecha DESC);
      CREATE INDEX IF NOT EXISTS idx_historial_tipo ON historial_cambios(tipo);
      CREATE INDEX IF NOT EXISTS idx_clientes_telefono ON clientes(telefono);
      CREATE INDEX IF NOT EXISTS idx_platos_categoria ON platos(categoria_id);
      CREATE INDEX IF NOT EXISTS idx_platos_disponible ON platos(disponible);
    `);

    console.log('✅ Tablas creadas correctamente');

    // Insertar datos iniciales si no existen
    const checkRestaurante = await pool.query('SELECT COUNT(*) FROM restaurante');
    
    if (checkRestaurante.rows[0].count === '0') {
      console.log('📝 Insertando datos iniciales...');
      
      // Datos del restaurante
      await pool.query(`
        INSERT INTO restaurante (nombre, direccion, telefono, web, email, descripcion)
        VALUES ('La Bona Taula', 'Carrer de València 234, Barcelona', '+34 932 15 47 89', 
                'www.labonataula.es', 'reservas@labonataula.es', 
                'Cocina mediterránea moderna con productos de temporada')
      `);

      // Horarios por defecto
      for (let dia = 0; dia < 7; dia++) {
        if (dia === 0) { // Domingo cerrado
          await pool.query(`
            INSERT INTO horarios (dia_semana, cerrado)
            VALUES ($1, true)
          `, [dia]);
        } else {
          await pool.query(`
            INSERT INTO horarios (dia_semana, apertura, cierre, turno_comida_inicio, turno_comida_fin, turno_cena_inicio, turno_cena_fin, cerrado)
            VALUES ($1, '13:00', '23:30', '13:00', '16:00', '20:00', '23:30', false)
          `, [dia]);
        }
      }

      // Mesas iniciales
      const mesas = [
        ['1', 2, 'interior', 'ventana'],
        ['2', 2, 'interior', 'ventana'],
        ['3', 4, 'interior', 'centro'],
        ['4', 4, 'interior', 'centro'],
        ['5', 6, 'interior', 'esquina'],
        ['6', 2, 'interior', 'barra'],
        ['7', 2, 'interior', 'barra'],
        ['8', 4, 'interior', 'centro'],
        ['9', 6, 'interior', 'esquina'],
        ['10', 8, 'interior', 'privado'],
        ['T1', 4, 'terraza', 'exterior'],
        ['T2', 4, 'terraza', 'exterior'],
        ['T3', 2, 'terraza', 'exterior']
      ];

      for (const mesa of mesas) {
        await pool.query(
          'INSERT INTO mesas (numero_mesa, capacidad, zona, ubicacion) VALUES ($1, $2, $3, $4)',
          mesa
        );
      }

      // Políticas por defecto
      await pool.query(`
        INSERT INTO politicas (
          cancelacion_horas, tiempo_mesa_minutos, niños_permitidos, 
          mascotas_permitidas, mascotas_solo_terraza, confirmacion_requerida
        ) VALUES (24, 120, true, true, true, true)
      `);

      // Categorías del menú
      const categorias = [
        ['Entrantes', 'Para compartir', 1],
        ['Ensaladas', 'Frescas y saludables', 2],
        ['Principales', 'Platos principales', 3],
        ['Carnes', 'A la brasa', 4],
        ['Pescados', 'Del mercado', 5],
        ['Postres', 'Para endulzar', 6],
        ['Bebidas', 'Refrescos y aguas', 7],
        ['Vinos', 'Nuestra selección', 8]
      ];

      for (const cat of categorias) {
        await pool.query(
          'INSERT INTO categorias_menu (nombre, descripcion, orden) VALUES ($1, $2, $3)',
          cat
        );
      }

      // Alérgenos estándar
      const alergenos = [
        'Gluten', 'Crustáceos', 'Huevos', 'Pescado', 
        'Cacahuetes', 'Soja', 'Lácteos', 'Frutos de cáscara',
        'Apio', 'Mostaza', 'Sésamo', 'Sulfitos', 
        'Altramuces', 'Moluscos'
      ];

      for (const alergeno of alergenos) {
        await pool.query(
          'INSERT INTO alergenos (nombre) VALUES ($1) ON CONFLICT DO NOTHING',
          [alergeno]
        );
      }

      // Algunos platos de ejemplo
      const platos = [
        [1, 'Bravas de la casa', 'Patatas con nuestra salsa especial', 8.50, true, false],
        [1, 'Croquetas de jamón', '8 unidades caseras', 9.00, true, false],
        [1, 'Calamares a la andaluza', 'Frescos y crujientes', 12.00, true, false],
        [2, 'Ensalada César', 'Con pollo y parmesano', 11.50, true, false],
        [2, 'Ensalada de burrata', 'Con tomate y albahaca', 13.00, true, true],
        [3, 'Paella valenciana', 'Mínimo 2 personas', 18.00, true, false],
        [4, 'Entrecot de ternera', '300g a la brasa', 24.00, true, false],
        [5, 'Lubina a la sal', 'Pescado salvaje', 22.00, true, false],
        [6, 'Tarta de queso', 'Casera', 6.50, true, true],
        [6, 'Brownie', 'Con helado', 7.00, true, true]
      ];

      for (const plato of platos) {
        await pool.query(
          `INSERT INTO platos (categoria_id, nombre, descripcion, precio, disponible, vegetariano) 
           VALUES ($1, $2, $3, $4, $5, $6)`,
          plato
        );
      }

      console.log('✅ Datos iniciales insertados');
    }

    console.log('🎉 Base de datos inicializada correctamente');
    
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  initDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = initDatabase;
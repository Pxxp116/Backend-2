/**
 * Sistema Centralizado de Validación de Reservas
 * Resuelve problemas de solapamiento, especialmente en mesa 3
 */

const { Pool } = require('pg');

/**
 * Verifica si hay solapamiento entre dos intervalos de tiempo
 * @param {string} inicio1 - Hora inicio primera reserva (HH:MM)
 * @param {number} duracion1 - Duración en minutos
 * @param {string} inicio2 - Hora inicio segunda reserva (HH:MM)
 * @param {number} duracion2 - Duración en minutos
 * @returns {boolean} true si hay solapamiento
 */
function haySolapamiento(inicio1, duracion1, inicio2, duracion2) {
  // Convertir horas a minutos
  const [h1, m1] = inicio1.split(':').map(Number);
  const [h2, m2] = inicio2.split(':').map(Number);
  
  const minutosInicio1 = h1 * 60 + m1;
  const minutosFin1 = minutosInicio1 + duracion1;
  
  const minutosInicio2 = h2 * 60 + m2;
  const minutosFin2 = minutosInicio2 + duracion2;
  
  // Lógica de intervalos: hay solapamiento si inicio1 < fin2 Y inicio2 < fin1
  const solapamiento = minutosInicio1 < minutosFin2 && minutosInicio2 < minutosFin1;
  
  if (solapamiento) {
    console.log(`⚠️ [SOLAPAMIENTO] Detectado entre ${inicio1}-${formatearMinutos(minutosFin1)} y ${inicio2}-${formatearMinutos(minutosFin2)}`);
  }
  
  return solapamiento;
}

/**
 * Formatea minutos a HH:MM
 */
function formatearMinutos(minutos) {
  const horas = Math.floor(minutos / 60);
  const mins = minutos % 60;
  return `${String(horas).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Verifica solapamientos para una reserva específica
 * Consulta DIRECTAMENTE la base de datos, no usa archivo espejo
 * @param {Pool} pool - Pool de conexiones PostgreSQL
 * @param {number} mesaId - ID de la mesa
 * @param {string} fecha - Fecha de la reserva (YYYY-MM-DD)
 * @param {string} hora - Hora de inicio (HH:MM)
 * @param {number} duracion - Duración en minutos
 * @param {string} reservaIdExcluir - ID de reserva a excluir (para modificaciones)
 * @param {number} duracionPorDefecto - Duración por defecto cuando no está especificada en la reserva
 * @returns {Promise<{valido: boolean, conflictos: Array, mensaje: string}>}
 */
async function verificarSolapamiento(pool, mesaId, fecha, hora, duracion, reservaIdExcluir = null, duracionPorDefecto = 120) {
  const esMesa3 = mesaId === 3;
  
  if (esMesa3) {
    console.log(`\n🔍 [MESA 3 - VALIDACIÓN ESPECIAL] Verificando solapamientos para mesa crítica`);
    console.log(`   📅 Fecha: ${fecha}`);
    console.log(`   🕐 Hora: ${hora}`);
    console.log(`   ⏱️ Duración: ${duracion} minutos`);
  }
  
  try {
    // Consulta DIRECTA a la BD - no usar archivo espejo
    let query = `
      SELECT 
        r.id,
        r.codigo_reserva,
        r.hora,
        COALESCE(r.duracion, $3) as duracion,
        r.estado,
        c.nombre as cliente_nombre,
        r.origen
      FROM reservas r
      JOIN clientes c ON r.cliente_id = c.id
      WHERE r.mesa_id = $1
        AND r.fecha = $2
        AND r.estado IN ('confirmada', 'pendiente')
    `;
    
    const params = [mesaId, fecha, duracionPorDefecto];
    
    // Si hay una reserva a excluir (modificación)
    if (reservaIdExcluir) {
      query += ` AND r.id != $4`;
      params.push(reservaIdExcluir);
    }
    
    query += ` ORDER BY r.hora`;
    
    const result = await pool.query(query, params);
    const reservasExistentes = result.rows;
    
    if (esMesa3) {
      console.log(`   📊 Reservas existentes en mesa 3: ${reservasExistentes.length}`);
    }
    
    const conflictos = [];
    
    // Verificar cada reserva existente
    for (const reserva of reservasExistentes) {
      if (haySolapamiento(hora, duracion, reserva.hora, reserva.duracion)) {
        const conflicto = {
          codigo: reserva.codigo_reserva,
          hora_inicio: reserva.hora,
          hora_fin: formatearMinutos(
            parseInt(reserva.hora.split(':')[0]) * 60 + 
            parseInt(reserva.hora.split(':')[1]) + 
            reserva.duracion
          ),
          cliente: reserva.cliente_nombre,
          origen: reserva.origen
        };
        
        conflictos.push(conflicto);
        
        if (esMesa3) {
          console.log(`   ❌ [MESA 3] Conflicto con reserva ${conflicto.codigo}: ${conflicto.hora_inicio}-${conflicto.hora_fin}`);
        }
      }
    }
    
    // Verificación adicional: reservas en curso (si es para hoy)
    const hoy = new Date().toISOString().split('T')[0];
    if (fecha === hoy) {
      const ahora = new Date();
      const horaActual = ahora.getHours() * 60 + ahora.getMinutes();
      const [horaRes, minRes] = hora.split(':').map(Number);
      const minutosReserva = horaRes * 60 + minRes;
      
      // Verificar reservas actualmente en curso
      const reservasEnCurso = await pool.query(`
        SELECT 
          r.codigo_reserva,
          r.hora,
          COALESCE(r.duracion, $3) as duracion
        FROM reservas r
        WHERE r.mesa_id = $1
          AND r.fecha = $2
          AND r.estado = 'confirmada'
          AND NOW()::TIME BETWEEN r.hora 
          AND (r.hora + COALESCE(r.duracion, $3) * INTERVAL '1 minute')
      `, [mesaId, fecha, duracionPorDefecto]);
      
      if (reservasEnCurso.rows.length > 0) {
        const reservaActiva = reservasEnCurso.rows[0];
        const finReservaActiva = parseInt(reservaActiva.hora.split(':')[0]) * 60 + 
                                parseInt(reservaActiva.hora.split(':')[1]) + 
                                reservaActiva.duracion;
        
        if (minutosReserva < finReservaActiva) {
          conflictos.push({
            codigo: reservaActiva.codigo_reserva,
            hora_inicio: reservaActiva.hora,
            hora_fin: formatearMinutos(finReservaActiva),
            cliente: 'EN CURSO AHORA',
            origen: 'activa'
          });
          
          if (esMesa3) {
            console.log(`   ⚠️ [MESA 3] Mesa actualmente ocupada hasta ${formatearMinutos(finReservaActiva)}`);
          }
        }
      }
    }
    
    // Resultado de la validación
    const valido = conflictos.length === 0;
    let mensaje = '';
    
    if (!valido) {
      if (esMesa3) {
        mensaje = `Mesa 3 no disponible (${conflictos.length} conflicto${conflictos.length > 1 ? 's' : ''}). `;
      } else {
        mensaje = `Mesa ${mesaId} no disponible. `;
      }
      
      const primerConflicto = conflictos[0];
      mensaje += `Conflicto con reserva ${primerConflicto.codigo} (${primerConflicto.hora_inicio}-${primerConflicto.hora_fin})`;
    } else {
      if (esMesa3) {
        console.log(`   ✅ [MESA 3] Sin conflictos - Mesa disponible`);
      }
      mensaje = `Mesa ${mesaId} disponible`;
    }
    
    return {
      valido,
      conflictos,
      mensaje,
      mesa_id: mesaId,
      es_mesa_3: esMesa3
    };
    
  } catch (error) {
    console.error(`❌ Error verificando solapamiento:`, error);
    
    // En caso de error, ser conservador y rechazar
    return {
      valido: false,
      conflictos: [],
      mensaje: 'Error al verificar disponibilidad. Por seguridad, no se puede confirmar la reserva.',
      mesa_id: mesaId,
      es_mesa_3: esMesa3,
      error: error.message
    };
  }
}

/**
 * Busca mesas disponibles sin solapamiento
 * @param {Pool} pool - Pool de conexiones
 * @param {string} fecha - Fecha de la reserva
 * @param {string} hora - Hora de inicio
 * @param {number} personas - Número de personas
 * @param {number} duracion - Duración en minutos
 * @param {number} duracionPorDefecto - Duración por defecto cuando no está especificada
 * @returns {Promise<Array>} Lista de mesas disponibles
 */
async function buscarMesasDisponibles(pool, fecha, hora, personas, duracion, duracionPorDefecto = 120) {
  try {
    console.log(`\n🔍 [BUSCAR MESAS] Buscando para ${fecha} ${hora} (${personas} personas, ${duracion} min)`);
    
    // Primero obtener todas las mesas candidatas
    const mesasCandidatas = await pool.query(`
      SELECT id, numero_mesa, capacidad, zona
      FROM mesas
      WHERE capacidad >= $1
        AND capacidad <= $1 + 2
        AND activa = true
      ORDER BY capacidad, numero_mesa
    `, [personas]);
    
    console.log(`   📊 Mesas candidatas: ${mesasCandidatas.rows.length}`);
    
    const mesasDisponibles = [];
    
    // Verificar cada mesa candidata
    for (const mesa of mesasCandidatas.rows) {
      const validacion = await verificarSolapamiento(pool, mesa.id, fecha, hora, duracion, null, duracionPorDefecto);
      
      if (validacion.valido) {
        mesasDisponibles.push({
          ...mesa,
          disponible: true,
          mensaje: validacion.mensaje
        });
        
        // Log especial si mesa 3 está disponible
        if (mesa.id === 3) {
          console.log(`   ✅ [MESA 3] DISPONIBLE para esta reserva`);
        }
      } else {
        // Log especial si mesa 3 NO está disponible
        if (mesa.id === 3) {
          console.log(`   ❌ [MESA 3] NO DISPONIBLE - ${validacion.conflictos.length} conflictos`);
        }
      }
    }
    
    console.log(`   ✅ Mesas disponibles: ${mesasDisponibles.length}`);
    
    return mesasDisponibles;
    
  } catch (error) {
    console.error('❌ Error buscando mesas disponibles:', error);
    return [];
  }
}

/**
 * Encuentra horarios alternativos sin solapamiento
 * @param {Pool} pool - Pool de conexiones
 * @param {number} mesaId - ID de la mesa específica (opcional)
 * @param {string} fecha - Fecha de la reserva
 * @param {string} horaOriginal - Hora originalmente solicitada
 * @param {number} personas - Número de personas
 * @param {number} duracion - Duración en minutos
 * @param {object} horarioRestaurante - Horario de apertura/cierre
 * @param {number} duracionPorDefecto - Duración por defecto cuando no está especificada
 * @returns {Promise<Array>} Lista de horarios alternativos
 */
async function buscarHorariosAlternativos(pool, mesaId, fecha, horaOriginal, personas, duracion, horarioRestaurante, duracionPorDefecto = 120) {
  try {
    const alternativas = [];
    const [horaOrig, minOrig] = horaOriginal.split(':').map(Number);
    const minutosOriginal = horaOrig * 60 + minOrig;
    
    // Rango de búsqueda: ±3 horas
    const rangoMinutos = 180;
    const desde = Math.max(minutosOriginal - rangoMinutos, 8 * 60); // No antes de las 8:00
    const hasta = Math.min(minutosOriginal + rangoMinutos, 23 * 60); // No después de las 23:00
    
    console.log(`\n🔍 [ALTERNATIVAS] Buscando horarios alternativos ${formatearMinutos(desde)}-${formatearMinutos(hasta)}`);
    
    // Verificar cada slot de 30 minutos
    for (let minutos = desde; minutos <= hasta; minutos += 30) {
      const horaAlternativa = formatearMinutos(minutos);
      
      // Saltar la hora original
      if (horaAlternativa === horaOriginal) continue;
      
      // Para hoy, verificar que sea futuro
      const hoy = new Date().toISOString().split('T')[0];
      if (fecha === hoy) {
        const ahora = new Date();
        const minutosActuales = ahora.getHours() * 60 + ahora.getMinutes();
        if (minutos <= minutosActuales + 30) continue; // Necesita 30 min de anticipación
      }
      
      // Buscar mesas disponibles en este horario
      let mesasDisponibles;
      
      if (mesaId) {
        // Verificar mesa específica
        const validacion = await verificarSolapamiento(pool, mesaId, fecha, horaAlternativa, duracion, null, duracionPorDefecto);
        mesasDisponibles = validacion.valido ? 1 : 0;
      } else {
        // Buscar cualquier mesa
        const mesas = await buscarMesasDisponibles(pool, fecha, horaAlternativa, personas, duracion, duracionPorDefecto);
        mesasDisponibles = mesas.length;
      }
      
      if (mesasDisponibles > 0) {
        alternativas.push({
          hora: horaAlternativa,
          mesas_disponibles: mesasDisponibles,
          diferencia_minutos: Math.abs(minutos - minutosOriginal)
        });
      }
    }
    
    // Ordenar por cercanía a la hora original
    alternativas.sort((a, b) => a.diferencia_minutos - b.diferencia_minutos);
    
    console.log(`   ✅ Encontradas ${alternativas.length} alternativas`);
    
    return alternativas.slice(0, 5); // Máximo 5 alternativas
    
  } catch (error) {
    console.error('❌ Error buscando horarios alternativos:', error);
    return [];
  }
}

module.exports = {
  verificarSolapamiento,
  buscarMesasDisponibles,
  buscarHorariosAlternativos,
  haySolapamiento
};
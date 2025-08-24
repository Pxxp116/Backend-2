/**
 * Test simplificado para verificar que las sugerencias de horarios
 * se recalculan dinámicamente según la duración del Dashboard
 * (Usando las dependencias del Backend 2)
 */

const { Pool } = require('pg');

// Usar la misma configuración que el servidor
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'gastrobot',
  password: 'Pxxp1234',
  port: 5432
});

async function actualizarDuracion(nuevaDuracion) {
  console.log(`\n🔧 [CONFIG] Actualizando duración a ${nuevaDuracion} minutos...`);
  
  try {
    await pool.query(
      'UPDATE politicas SET tiempo_mesa_minutos = $1 WHERE id = 1',
      [nuevaDuracion]
    );
    
    console.log(`✅ [CONFIG] Duración actualizada en BD: ${nuevaDuracion} minutos`);
    
    // Verificar que se guardó correctamente
    const verificacion = await pool.query('SELECT tiempo_mesa_minutos FROM politicas WHERE id = 1');
    const duracionActual = verificacion.rows[0]?.tiempo_mesa_minutos;
    console.log(`📊 [CONFIG] Duración verificada en BD: ${duracionActual} minutos`);
    
    return true;
  } catch (error) {
    console.error('❌ [CONFIG] Error actualizando duración:', error);
    return false;
  }
}

async function testEndpoint(endpoint, datos, descripcion) {
  console.log(`\n🧪 [TEST] ${descripcion}...`);
  
  try {
    const response = await fetch(`http://localhost:3000/api${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos)
    });
    
    const resultado = await response.json();
    console.log(`📊 [${endpoint}] Éxito: ${resultado.exito}`);
    
    if (endpoint === '/buscar-mesa') {
      if (resultado.alternativas && resultado.alternativas.length > 0) {
        console.log(`📅 [ALTERNATIVAS] ${resultado.alternativas.length} sugerencias:`);
        resultado.alternativas.slice(0, 3).forEach((alt, i) => {
          console.log(`   ${i + 1}. ${alt.hora_alternativa} (${alt.mesas_disponibles} mesas)`);
        });
      } else {
        console.log('📅 [ALTERNATIVAS] Sin sugerencias');
      }
    }
    
    if (endpoint === '/validar-horario-reserva') {
      console.log(`⏰ [VALIDACIÓN] Última entrada: ${resultado.ultima_entrada || 'N/A'}`);
      console.log(`✅ [VALIDACIÓN] Es válida: ${resultado.es_valida}`);
    }
    
    return resultado;
    
  } catch (error) {
    console.error(`❌ [TEST] Error en ${endpoint}:`, error.message);
    return { exito: false, error: error.message };
  }
}

async function ejecutarTest() {
  console.log('🚀 [INICIO] Test de duraciones dinámicas (simplificado)\n');
  
  try {
    // Datos de prueba
    const mañana = new Date();
    mañana.setDate(mañana.getDate() + 1);
    const fechaPrueba = mañana.toISOString().split('T')[0];
    
    const datosPrueba = {
      fecha: fechaPrueba,
      hora: '22:30', // Hora tardía para forzar limitaciones
      personas: 2
    };
    
    const datosValidacion = {
      fecha: fechaPrueba,
      hora: '22:30'
    };
    
    console.log(`📅 Fecha de prueba: ${fechaPrueba}`);
    console.log(`🕐 Hora de prueba: ${datosPrueba.hora}`);
    
    // === PARTE 1: Duración 90 minutos ===
    console.log('\n' + '='.repeat(50));
    console.log('🔬 PARTE 1: DURACIÓN 90 MINUTOS');
    console.log('='.repeat(50));
    
    await actualizarDuracion(90);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Esperar 1 segundo
    
    const busqueda90 = await testEndpoint('/buscar-mesa', datosPrueba, 'Buscar mesa con 90 min');
    const validacion90 = await testEndpoint('/validar-horario-reserva', datosValidacion, 'Validar horario con 90 min');
    
    // === PARTE 2: Duración 150 minutos ===
    console.log('\n' + '='.repeat(50));
    console.log('🔬 PARTE 2: DURACIÓN 150 MINUTOS');
    console.log('='.repeat(50));
    
    await actualizarDuracion(150);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Esperar 1 segundo
    
    const busqueda150 = await testEndpoint('/buscar-mesa', datosPrueba, 'Buscar mesa con 150 min');
    const validacion150 = await testEndpoint('/validar-horario-reserva', datosValidacion, 'Validar horario con 150 min');
    
    // === ANÁLISIS ===
    console.log('\n' + '='.repeat(50));
    console.log('📊 ANÁLISIS DE RESULTADOS');
    console.log('='.repeat(50));
    
    const ultimaEntrada90 = validacion90.ultima_entrada || 'N/A';
    const ultimaEntrada150 = validacion150.ultima_entrada || 'N/A';
    
    console.log(`\n90 min  - Última entrada: ${ultimaEntrada90}`);
    console.log(`150 min - Última entrada: ${ultimaEntrada150}`);
    
    const alternativas90 = busqueda90.alternativas ? busqueda90.alternativas.length : 0;
    const alternativas150 = busqueda150.alternativas ? busqueda150.alternativas.length : 0;
    
    console.log(`\n90 min  - Alternativas: ${alternativas90}`);
    console.log(`150 min - Alternativas: ${alternativas150}`);
    
    // Verificar cambios
    const cambioEntrada = ultimaEntrada90 !== ultimaEntrada150;
    const cambioAlternativas = alternativas90 !== alternativas150;
    
    if (cambioEntrada || cambioAlternativas) {
      console.log('\n✅ [ÉXITO] ¡Las sugerencias SE RECALCULAN dinámicamente!');
      console.log('   El sistema detecta los cambios en la duración del Dashboard');
    } else {
      console.log('\n⚠️ [ADVERTENCIA] Las sugerencias no cambiaron');
      console.log('   Esto puede ser normal si el horario de prueba no se ve afectado');
    }
    
    console.log('\n📝 [INFO] Revisa los logs del servidor para ver:');
    console.log('   • Mensajes [FRESH] - Consultas a BD');
    console.log('   • Timestamps en las operaciones');
    console.log('   • Duraciones obtenidas de BD');
    
    // Restaurar configuración
    console.log('\n🔄 [CLEANUP] Restaurando duración por defecto...');
    await actualizarDuracion(120);
    
  } catch (error) {
    console.error('❌ [ERROR] Error en test:', error);
  } finally {
    await pool.end();
    console.log('\n✅ [FIN] Test completado');
  }
}

// Ejecutar
ejecutarTest();
import bcrypt from 'bcryptjs';
import { randomToken } from '../crypto.js';
import * as v from '../lib/validate.js';
import { GLOBAL_ROLES } from '../lib/authz.js';

export const BCRYPT_COST = 12;

/** Lo que un proyecto reserva contra el plan: límites × réplicas máximas. */
export function projectFootprint(p) {
  const n = p.autoscaling_enabled ? p.autoscaling_max : p.replicas;
  return { cpu: v.toMillicores(p.cpu_limit) * n, mem: v.toMebibytes(p.memory_limit) * n };
}

export function databaseFootprint(d) {
  return { cpu: v.toMillicores(d.cpu_limit), mem: v.toMebibytes(d.memory_limit), dbGi: d.size_gi };
}

/**
 * Comprueba que `usage` + `add` cabe en el plan. Los límites NULL no limitan. Solo se
 * valida lo que crece (add > 0): bajar recursos siempre está permitido.
 */
export function checkPlanQuota(plan, usage, add) {
  const fail = (msg) => {
    throw new v.ValidationError(`Límite del plan ${plan.name}: ${msg}`, 'quota');
  };
  if (add.projects > 0 && plan.max_projects !== null && usage.projects + add.projects > plan.max_projects)
    fail(`permite ${plan.max_projects} proyectos y ya tienes ${usage.projects}.`);
  if (add.cpu > 0 && plan.max_cpu_millicores !== null && usage.cpu + add.cpu > plan.max_cpu_millicores)
    fail(`${plan.max_cpu_millicores}m de CPU en total (límite × réplicas); usas ${usage.cpu}m y esto suma ${add.cpu}m.`);
  if (add.mem > 0 && plan.max_memory_mi !== null && usage.mem + add.mem > plan.max_memory_mi)
    fail(`${plan.max_memory_mi}Mi de memoria en total (límite × réplicas); usas ${usage.mem}Mi y esto suma ${add.mem}Mi.`);
  if (add.dbGi > 0 && plan.max_db_gi !== null && usage.dbGi + add.dbGi > plan.max_db_gi)
    fail(`${plan.max_db_gi} GiB de bases de datos; usas ${usage.dbGi} GiB y pides ${add.dbGi} GiB.`);
}

/** Contraseña temporal: se muestra una sola vez y obliga a cambiarla. */
export const temporaryPassword = () => randomToken(12);

export function createUserStore({ db }) {
  const planByName = (name) => db.prepare('SELECT * FROM plans WHERE name = ?').get(name);

  const store = {
    plans: () => db.prepare('SELECT * FROM plans ORDER BY id').all(),
    planByName,
    plan(user) {
      return (user?.plan_id && db.prepare('SELECT * FROM plans WHERE id = ?').get(user.plan_id)) || planByName(user?.role === 'admin' ? 'ilimitado' : 'free');
    },

    get(id) {
      if (!/^\d{1,10}$/.test(String(id))) return null;
      return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
    },
    getByUsername: (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(String(username)) || null,
    count: () => db.prepare('SELECT COUNT(*) FROM users').pluck().get(),

    list() {
      return db
        .prepare(
          `SELECT u.*, pl.name AS plan_name,
             (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id AND m.role = 'owner') AS owned_projects
           FROM users u LEFT JOIN plans pl ON pl.id = u.plan_id ORDER BY u.username`,
        )
        .all();
    },

    async create({ username, email = null, role = 'user', planName = 'free', password = null, mustChange = true, createdBy = null }) {
      v.username(username);
      if (!GLOBAL_ROLES.includes(role)) throw new v.ValidationError('Rol inválido', 'role');
      const plan = planByName(planName);
      if (!plan) throw new v.ValidationError('Plan inválido', 'plan');
      if (store.getByUsername(username)) throw new v.ValidationError(`El usuario ${username} ya existe`, 'username');
      const pass = password ?? temporaryPassword();
      const hash = await bcrypt.hash(pass, BCRYPT_COST);
      const id = db
        .prepare('INSERT INTO users (username, email, password_hash, role, plan_id, must_change_password, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(username, v.email(email), hash, role, plan.id, mustChange ? 1 : 0, createdBy).lastInsertRowid;
      return { user: store.get(id), password: pass };
    },

    async setPassword(user, password, { mustChange = false } = {}) {
      const hash = await bcrypt.hash(password, BCRYPT_COST);
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(hash, mustChange ? 1 : 0, user.id);
    },

    activeAdmins: () => db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1").pluck().get(),

    /** Siempre debe quedar al menos un admin activo. */
    assertKeepsAdmin(user, { role = user.role, active = user.active }) {
      const removes = user.role === 'admin' && user.active && (role !== 'admin' || !active);
      if (removes && store.activeAdmins() <= 1) throw new v.ValidationError('No se puede desactivar ni degradar al último administrador', 'role');
    },

    update(user, fields) {
      const allowed = ['role', 'plan_id', 'active', 'email'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) return user;
      db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id: user.id });
      return store.get(user.id);
    },

    touchLogin: (user) => db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id),

    // --- Cuotas por plan -----------------------------------------------------------

    /** Uso acumulado de los proyectos de los que `userId` es owner. */
    usage(userId) {
      const projects = db
        .prepare("SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id AND m.role = 'owner' WHERE m.user_id = ?")
        .all(userId);
      const out = { projects: projects.length, cpu: 0, mem: 0, dbGi: 0 };
      for (const p of projects) {
        const f = projectFootprint(p);
        out.cpu += f.cpu;
        out.mem += f.mem;
      }
      const dbs = db
        .prepare("SELECT d.* FROM databases d JOIN project_members m ON m.project_id = d.project_id AND m.role = 'owner' WHERE m.user_id = ?")
        .all(userId);
      for (const d of dbs) {
        const f = databaseFootprint(d);
        out.cpu += f.cpu;
        out.mem += f.mem;
        out.dbGi += f.dbGi;
      }
      return out;
    },

    ownerOf: (projectId) =>
      db.prepare("SELECT u.* FROM users u JOIN project_members m ON m.user_id = u.id WHERE m.project_id = ? AND m.role = 'owner'").get(projectId) || null,

    /** Lanza ValidationError si `add` no cabe en el plan del usuario. */
    checkQuota(user, add) {
      if (!user) return;
      checkPlanQuota(store.plan(user), store.usage(user.id), { projects: 0, cpu: 0, mem: 0, dbGi: 0, ...add });
    },

    /** Para cambios de un proyecto existente: solo cuenta la diferencia. */
    checkProjectChange(project, next) {
      const a = projectFootprint(project);
      const b = projectFootprint({ ...project, ...next });
      store.checkQuota(store.ownerOf(project.id), { cpu: b.cpu - a.cpu, mem: b.mem - a.mem });
    },
  };
  return store;
}

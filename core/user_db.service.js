// const Promise = require('promise');
const winston = require('winston');
const logger = winston.loggers.get('gomngr');

const cfgsrv = require('../core/config.service.js');
let my_conf = cfgsrv.get_conf();
const CONFIG = my_conf;

const Promise = require('promise');
const maisrv = require('../core/mail.service.js');
const dbsrv = require('../core/db.service.js');
const mysql = require('mysql');

exports.create_db_request = create_db_request;
exports.create_db = create_db;
exports.delete_db = delete_db;


var pool = null;
if(CONFIG.mysql.host) {
    pool = mysql.createPool({
        host     : CONFIG.mysql.host,
        user     : CONFIG.mysql.user,
        password : CONFIG.mysql.password,
        insecureAuth: true
    });
}

var querydb = (sql) => {
    return new Promise((resolve, reject) => {
        if(pool === null) {
            reject('no mysql pool defined');
            return;
        }
        pool.getConnection((err, connection) => {
            if(err) {
                logger.error('failed to get connection', err);
                reject(err);
                return;
            }
            // eslint-disable-next-line no-unused-vars
            connection.query(sql, function(err, results) {
                connection.release();
                if(err) {
                    logger.error('failed to exec sql', sql, err);
                    reject(err);
                    return;
                }
                logger.debug('sql result', sql, results);
                resolve(true);
            });
        });
    });
};


async function create_db_request(asked_db, user) {
    logger.info('Create Database Request ' + asked_db.name + ' for ' + user.uid);
    await dbsrv.mongo_pending_databases().insertOne(asked_db);
    await dbsrv.mongo_events().insertOne({
        owner: user.uid,
        date: new Date().getTime(),
        action:  'new pending database ' + asked_db.name + ' asked for by ' +  user.uid,
        logs: [],
    });
    let msg_destinations =  [CONFIG.general.accounts, user.email];
    if (user.send_copy_to_support) {
        msg_destinations.push(CONFIG.general.support);
    }
    try {
        await maisrv.send_notif_mail({
            'name': 'ask_database',
            'destinations': msg_destinations,
            'subject': 'Database creation request: ' + asked_db.id
        }, {
            '#UID#':  user.uid,
            '#NAME#': asked_db.name,
            '#SIZE#': asked_db.size,
            '#USAGE#': asked_db.usage,
            '#EXP#': asked_db.expire
        });
    } catch(error) {
        logger.error(error);
    }
}


async function create_db(new_db, user, id) {
    let createdb = 'CREATE DATABASE ' + id + ';\n';
    try {
        await querydb(createdb);
        //await connection.query(createdb);
    } catch(err) {
        logger.error('sql error', err);
        await dbsrv.mongo_events().insertOne({'owner': user.uid, 'date': new Date().getTime(), 'action': 'database creation error ' + id , 'logs': []});
        throw {code: 500, message: 'Creation error: ' + err};
    }

    //let password = Math.random().toString(36).slice(-10);
    let password = usrsrv.new_password(10);
    let createuser = `CREATE USER '${id}'@'%' IDENTIFIED BY '${password}';\n`;
    try {
        await querydb(createuser);
        //await connection.query(createuser);
    } catch(err) {
        logger.error('sql error', err);
        throw {code: 500, message: 'Failed to create user'};
    }

    let grant = `GRANT ALL PRIVILEGES ON ${id}.* TO '${id}'@'%'\n`;
    try {
        await querydb(grant);
        //await connection.query(grant);
    } catch(err) {
        logger.error('sql error', err);
        throw {code: 500, message: 'Failed to grant access to user'};
    }

    try {
        await maisrv.send_notif_mail({
            'name': 'database_creation',
            'destinations': [user.email, CONFIG.general.accounts],
            'subject': 'Database creation'
        }, {
            '#OWNER#': new_db.owner,
            '#DBHOST#': CONFIG.mysql.host,
            '#DBNAME#': id,
            '#DBUSER#': id,
            '#DBPASSWORD#': password
        });
    } catch(error) {
        logger.error(error);
    }
    await dbsrv.mongo_pending_databases().deleteOne({ name: db.name });
    await dbsrv.mongo_events().insertOne({'owner': user.uid, 'date': new Date().getTime(), 'action': 'database ' + id + ' created for ' +  db.owner, 'logs': []});
}


async function delete_db(user, db_id) {
    logger.debug('delete_db', db_id);
    let filter = {name: db_id};
    if(!user.is_admin) {
        filter['owner'] = user.uid;
    }
    let database = await dbsrv.mongo_databases().findOne({name: db_id});
    if(!database || (database.type !== undefined && database.type != 'mysql')) {
        await dbsrv.mongo_databases().deleteOne(filter);
        await dbsrv.mongo_events().insertOne({
            'owner': user.uid,
            'date': new Date().getTime(),
            'action': 'database ' + db_id+ ' deleted by ' +  user.uid, 'logs': []
        });
        return true;
    } else {
        await dbsrv.mongo_databases().deleteOne(filter);
        try {
            let dropuser = `DROP USER '${db_id}'@'%';\n`;
            await querydb(dropuser);
            let dropdb = `DROP DATABASE ${db_id};\n`;
            await querydb(dropdb);
        } catch(err) {
            await dbsrv.mongo_events().insertOne({
                'owner': user.uid,
                'date': new Date().getTime(),
                'action': 'Error: database ' + db_id + ' could not be deleted by ' + user.uid, 'logs': []
            });
            return false;
        }
        await dbsrv.mongo_events().insertOne({
            'owner': user.uid,
            'date': new Date().getTime(),
            'action': 'database ' + db_id + ' deleted by ' + user.uid, 'logs': []
        });
        return true;
    }
}

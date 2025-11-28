import { cache, log, wait } from "mentie"
import { exec } from "child_process"
import { run } from "../system/shell.js"
import { count_available_socks, register_socks5_lease, write_socks } from "../database/worker_socks5.js"

/**
 * Checks if the Dante SOCKS5 server is reachable on its public IP and port.
 * @returns {Promise<boolean>} A promise that resolves to true if the server is reachable, false otherwise.
 */
async function check_if_dante_reachable() {

    try {

        // Run netcat command to check if we can ready the container on the public ip
        const { DANTE_PORT=1080, SERVER_PUBLIC_HOST } = process.env
        if( !SERVER_PUBLIC_HOST ) throw new Error( `SERVER_PUBLIC_HOST is not set in environment variables` )
        if( !DANTE_PORT ) throw new Error( `DANTE_PORT is not set in environment variables` )
        const command = `nc -vz -w 10 ${ SERVER_PUBLIC_HOST } ${ DANTE_PORT }`
        log.info( `Checking Dante reachability with command: ${ command }` )
        const { stdout, stderr } = await run( command )
        const outputs = `stdout: ${ stdout }, stderr: ${ stderr }`
        const reachable = outputs.includes( 'succeeded' )
        log.info( `Dante reachable: ${ reachable }, outputs: ${ outputs }` )
        return reachable

    } catch ( e ) {
        log.info( `Error checking Dante reachability: ${ e.message }` )
        return false
    }

}

/**
 * Waits until the Dante SOCKS5 server port is reachable or until the maximum wait time is exceeded.
 * @param {Object} params - The parameters for the function.
 * @param {number} [params.max_wait_ms=Infinity] - The maximum time in milliseconds to wait.
 * @returns {Promise<boolean>} A promise that resolves to true if the server becomes reachable within the wait period, or false otherwise.
 */
export async function dante_server_ready( { max_wait_ms=Infinity } = {} ) {

    // Time tracking
    const start_time = Date.now()
    let time_passed = 0
    log.info( `Checking if Dante SOCKS5 server is ready` )

    // Wait for port to be reachable
    let reachable = await check_if_dante_reachable()
    while( !reachable && time_passed < max_wait_ms ) {
        log.info( `Dante SOCKS5 server not reachable yet, waiting 5 seconds before retrying...` )
        await wait( 5000 )
        time_passed = Date.now() - start_time
        reachable = await check_if_dante_reachable()
    }

    return reachable

}

/**
 * Loads SOCKS5 authentication credentials from disk and writes them to the database.
 * Reads password files from the configured PASSWORD_DIR and creates sock objects for each.
 * @returns {Promise<Object>} A promise that resolves to an object with success status.
 * @returns {boolean} return.success - True if loading succeeded, false otherwise.
 * @returns {string} [return.error] - Error message if loading failed.
 */
export async function load_socks5_from_disk() {

    try {

        // Load the auth files from /passwords/*.password
        const { PASSWORD_DIR='/passwords', DANTE_PORT=1080, SERVER_PUBLIC_HOST } = process.env
        log.info( `Loading SOCKS5 auth files from directory: ${ PASSWORD_DIR }` )

        // Get auth files and used auth files
        let { stdout: auth_files='' } = await run( `ls -d1 ${ PASSWORD_DIR }/*.password` )
        let { stdout: used_auth_files='' } = await run( `ls -d1 ${ PASSWORD_DIR }/*.password.used || echo ""` )

        // Parse file lists
        auth_files = auth_files?.split( '\n'  )?.filter( f => !!`${ f }`.trim().length )
        used_auth_files = used_auth_files?.split( '\n' )?.filter( f => !!`${ f }`.trim().length )
        log.info( `Found ${ auth_files?.length } auth files, ${ used_auth_files?.length } used auth files` )

        // Create socks objects from auth files
        const socks = await Promise.all( auth_files.map( async auth_path => {

            // Get username from filename
            const filename = auth_path.split( '/' ).pop()
            const username = filename.replace( '.password', '' )

            // Check if already used
            const available = !used_auth_files.includes( auth_path )
            
            // Read password from file
            let { stdout: password } = await run( `cat ${ auth_path }` )
            password = `${ password }`.trim()
            if( !password?.length ) log.warn( `Password file ${ auth_path } is empty` )

            // Create sock object
            const sock = {
                ip_address: SERVER_PUBLIC_HOST,
                port: Number( DANTE_PORT ),
                username,
                password,
                available
            }

            return sock
            
        } ) )

        // Write sockt to database
        await write_socks( { socks } )
        cache( 'dante_config_initialised', true )
        log.info( `Loaded ${ socks.length } SOCKS5 configs from disk and saved to database` )

        return { success: true }


    } catch ( e ) {
        log.error( `Error in load_socks5_from_disk:`, e )
        return { success: false, error: e.message }
    }
}

/**
 * Restarts the Dante SOCKS5 container and invalidates the cached configuration.
 * Attempts to use docker compose restart first (better API compatibility), then falls back to docker restart.
 * Gracefully handles API version mismatches by logging warnings instead of errors.
 * @returns {Promise<void>} A promise that resolves when the container restart is attempted.
 */
export async function restart_dante_container() {

    log.info( `Restarting dante container` )
    let restart_success = false
    let last_error = null
    
    // Try docker compose restart first (better API compatibility)
    const compose_files = [
        'docker-compose.yml',
        'docker-compose.ci.yml'
    ]
    
    for (const compose_file of compose_files) {
        try {
            const result = await run( `docker compose -f ${ compose_file } restart dante`, { verbose: true } )
            log.info( `docker compose restart succeeded with ${ compose_file }:`, result )
            restart_success = true
            break
        } catch ( compose_error ) {
            last_error = compose_error
            log.debug( `docker compose restart failed with ${ compose_file }, trying next method:`, compose_error.message )
        }
    }
    
    // Fall back to direct docker restart if compose failed
    if( !restart_success ) {
        try {
            const result = await new Promise( ( resolve, reject ) => {
                exec( `docker restart dante`, ( error, stdout, stderr ) => {
                    if( error ) {
                        const error_msg = `${ error.message }${ stderr || '' }`
                        // Gracefully handle API version mismatches - container may still be working
                        if( error_msg.includes( 'API version' ) || error_msg.includes( 'too old' ) ) {
                            log.warn( `Docker API version mismatch detected. Cannot restart dante container programmatically.` )
                            log.warn( `Container may still be working - restart is non-critical.` )
                            log.warn( `To restart manually, run from host: docker compose restart dante` )
                            return resolve( `API version warning (non-fatal): ${ error_msg }` )
                        }
                        return reject( error )
                    }
                    if( stderr ) return reject( stderr )
                    resolve( stdout )
                } )
            } )
            log.info( `Direct docker restart succeeded:`, result )
            restart_success = true
        } catch ( e ) {
            log.error( `Error in restart_dante_container:`, e )
        }
    }
    
    // Mark dante config as uninitialised so it reloads on next use (even if restart failed)
    if (restart_success) {
        cache( 'dante_config_initialised', false )
        log.info( `Dante container restart process completed.` )
    } else {
        log.warn( `Failed to restart dante container after all attempts. Last error:`, last_error?.message || 'Unknown error' )
        log.warn( `Container may still be working - this is non-critical. Config cache will be cleared anyway.` )
        cache( 'dante_config_initialised', false )
    }
}

/**
 * Retrieves a valid SOCKS5 configuration by leasing an available credential.
 * @param {Object} params - The parameters for the function.
 * @param {number} params.lease_seconds - The lease duration in seconds.
 * @returns {Promise<Object>} A promise that resolves to a SOCKS5 configuration object.
 * @returns {string} return.username - The SOCKS5 username.
 * @returns {string} return.password - The SOCKS5 password.
 * @returns {string} return.ip_address - The server IP address.
 * @returns {number} return.port - The server port.
 * @returns {number} return.expires_at - The expiration timestamp of the lease.
 */
export async function get_valid_socks5_config( { lease_seconds } ) {

    // Check if dante server is ready
    const dante_ready = await dante_server_ready()
    log.info( `Dante server ready: ${ dante_ready }` )

    // If we haven't loaded configs since boot, load them now
    const dante_config_initialised = cache( 'dante_config_initialised' )
    if( !dante_config_initialised ) await load_socks5_from_disk()

    // Formulate config parameters
    const expires_at = Date.now() +  lease_seconds * 1000 
    let { available_socks_count } = await count_available_socks()
    log.info( `There are ${ available_socks_count } available socks for lease_seconds: ${ lease_seconds }` )

    // If no socks available, restart the container
    if( !available_socks_count ) {
        log.info( `No available socks, restarting Dante container to refresh configs` )
        await restart_dante_container()
        await check_if_dante_reachable()
        const { available_socks_count: new_available_socks_count } = await count_available_socks()
        log.info( `After restarting Dante, there are ${ new_available_socks_count } available socks` )
        available_socks_count = new_available_socks_count
        if( !available_socks_count ) throw new Error( `No available socks after restarting Dante container` )
    }
    
    // Get lease
    const { success, error, sock } = await register_socks5_lease( { expires_at } )
    log.info( `Leased SOCKS5 config: ${ sock.username }@${ sock.ip_address }:${ sock.port }, expires at ${ new Date( expires_at ).toISOString() }` )
    if( !success ) throw new Error( `Error leasing SOCKS5 config: ${ error }` )

    // Return the sock config
    const socks5_config = {
        username: sock.username,
        password: sock.password,
        ip_address: sock.ip_address,
        port: sock.port
    }

    return { socks5_config, expires_at }

}
import { call } from '../util.js'

/** Never unlink a destination to work around an arbitrary rename failure. */
export async function renameRemote(sftp, from, to) {
  if (typeof sftp.ext_openssh_rename === 'function') {
    try {
      return await call(sftp, 'ext_openssh_rename', from, to)
    } catch (error) {
      // Only an unsupported extension permits falling back to standard SFTP.
      if (error?.code !== 8 && error?.message !== 'Server does not support this extended request') throw error
    }
  }
  return call(sftp, 'rename', from, to)
}

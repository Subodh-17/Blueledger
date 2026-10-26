package org.bluecarbon.mrv

import org.bluecarbon.mrv.util.CryptoUtils
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class CryptoUtilsTest {

    @Test
    fun sha256_emptyBytes_matchesStandardHash() {
        val hash = CryptoUtils.sha256(ByteArray(0))
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", hash)
    }

    @Test
    fun sha256_knownString_matchesExpected() {
        val input = "BlueCarbonMRV-SIH25038".toByteArray(Charsets.UTF_8)
        val hash = CryptoUtils.sha256(input)
        assertEquals(64, hash.length)
    }

    @Test
    fun sha256_fileContent_equalsBytesHash() {
        val temp = File.createTempFile("mrv_test", ".dat")
        try {
            val content = "Sample evidence binary payload 2026".toByteArray(Charsets.UTF_8)
            temp.writeBytes(content)
            val fileHash = CryptoUtils.sha256(temp)
            val byteHash = CryptoUtils.sha256(content)
            assertEquals(byteHash, fileHash)
        } finally {
            temp.delete()
        }
    }
}

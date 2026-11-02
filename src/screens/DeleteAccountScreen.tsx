/**
 * Delete-account screen (App Review guideline 5.1.1(v): deletion must be
 * offered in-app).
 *
 * Deletion never starts from a session alone. The flow here:
 *   1. type "DELETE" and tick the acknowledgement;
 *   2. when the account has 2FA, type the current code (or a recovery code);
 *   3. password step-up (`requestConfirmation`, the app's own sheet);
 *   4. `POST /api/v1/account/delete/request` makes the server email a
 *      single-use link (valid 1 hour). NOTHING is deleted yet.
 *   5. The screen shows "Check your email" with a masked address and Resend.
 *      The account is deleted only after the owner opens the link and
 *      confirms on the page; the next API call after that signs the app out
 *      through the usual account-deleted handler. This screen therefore
 *      never says "deleted" and never signs out.
 *
 * A server without the request route (404) gets an "update needed" message.
 * The screen deliberately does not fall back to the old DELETE endpoint.
 *
 * Voice: honest, no reassurance. No emojis. Danger styling matches
 * PrivacyScreen's `ActionRow danger`.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { radii, spacing, type Colors } from '../theme';
import { useAuth } from '../lib/auth';
import { requestConfirmation } from '../lib/confirm-action';
import { ApiError, friendlyError, requestAccountDeletion } from '../lib/api';
import {
  DELETION_LINK_TTL_LABEL,
  NEEDS_UPDATE_MESSAGE,
  classifyDeletionRequestError,
  maskEmail,
} from '../lib/delete-account-flow';

type C = Colors;

/** What deletion destroys — mirrors web's `deletionItems`, mobile-specific items added. */
const DESTROYED_ITEMS: [string, string][] = [
  ['Encryption keys', 'Master key and every derived file key'],
  ['All files and versions', 'Encrypted blobs shredded from all regions'],
  ['All shared links', 'Active links stop working immediately'],
  ['Device backups', 'Photo, contact, and calendar backups'],
];

export default function DeleteAccountScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const { user } = useAuth();
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;

  const [confirmation, setConfirmation] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [serverRequiresCode, setServerRequiresCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [resent, setResent] = useState(false);

  const needsCode = user?.totp_enabled === true || serverRequiresCode;
  const codeReady = !needsCode || totpCode.trim().length >= 6;

  // Client-side gate: a typo in the confirmation field, a missing code or an
  // unticked box sends ZERO network requests.
  const canDelete = confirmation === 'DELETE' && understood && codeReady && !loading;
  // Resend only needs a fresh code (a used code is refused) and the password.
  const canResend = codeReady && !loading;

  const styles = useMemo(
    () => makeStyles(c, resolved, accessibilityLayout),
    [accessibilityLayout, c, resolved],
  );

  const send = useCallback(async (isResend: boolean) => {
    setError(null);
    setResent(false);

    // Step-up re-auth: the password sheet exchanges it for a single-use
    // confirmation token. A wrong password re-prompts in place and never
    // returns a token, so the request below is not made without one.
    const token = await requestConfirmation({
      title: isResend ? 'Send the link again' : 'Confirm account deletion',
      message: isResend
        ? 'Enter your password to email a new confirmation link.'
        : 'Enter your password. We will email you a link to confirm. Nothing is deleted until you use it.',
    });
    if (!token) return; // cancelled, or the sheet already showed the error

    setLoading(true);
    try {
      await requestAccountDeletion(token, needsCode ? totpCode.trim() : undefined);
      // Single-use codes: clear it so a resend asks for a fresh one.
      setTotpCode('');
      setEmailSent(true);
      setResent(isResend);
    } catch (err) {
      const failure = classifyDeletionRequestError(err, ApiError);
      if (failure.kind === 'email_sent') {
        setTotpCode('');
        setEmailSent(true);
        setResent(isResend);
      } else if (failure.kind === 'needs_update') setError(NEEDS_UPDATE_MESSAGE);
      else if (failure.kind === 'code_required') {
        setServerRequiresCode(true);
        setError('Enter the 6-digit code from your authenticator app, or a recovery code.');
      }
      else if (failure.kind === 'invalid_code') setError('That code did not match. Check your authenticator app and try again.');
      else setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }, [needsCode, totpCode]);

  const handleDelete = useCallback(() => {
    if (!canDelete) return Promise.resolve();
    return send(false);
  }, [canDelete, send]);

  const handleResend = useCallback(() => {
    if (!canResend) return Promise.resolve();
    return send(true);
  }, [canResend, send]);

  const totpField = needsCode ? (
    <>
      <Text style={styles.label}>
        {emailSent ? 'New 2FA code, to send the link again' : 'Two-factor code'}
      </Text>
      <TextInput
        style={styles.input}
        value={totpCode}
        onChangeText={setTotpCode}
        placeholder="123456"
        placeholderTextColor={c.ink4}
        keyboardType="default"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        editable={!loading}
        textContentType="oneTimeCode"
        testID="delete-account-totp-input"
        accessibilityLabel="Two-factor code"
      />
    </>
  ) : null;

  if (emailSent) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View style={[styles.titleRow, styles.emailTitleRow]}>
            <Ionicons name="mail-outline" size={18} color={c.ink} />
            <Text style={styles.title}>Check your email</Text>
          </View>
        </View>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.card} testID="delete-account-email-sent">
            <Text style={styles.sentText}>
              We sent a link to {maskEmail(user?.email)}. Deleting starts only after you confirm
              on the page it opens. The link expires in {DELETION_LINK_TTL_LABEL}.
            </Text>
            <Text style={styles.sentText}>
              Until then nothing has changed: your account and files are still here and you stay
              signed in. After the account is deleted you have 30 days to cancel the deletion from
              the email we send then.
            </Text>
          </View>
          {resent && (
            <Text style={styles.sentNote} testID="delete-account-resent">A new link was sent. The old one no longer works.</Text>
          )}
          {totpField}
          {error && (
            <View style={styles.errorBanner} testID="delete-account-error">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton, !canResend && styles.buttonDisabled]}
              onPress={handleResend}
              disabled={!canResend}
              accessibilityRole="button"
              accessibilityLabel="Send the link again"
              testID="delete-account-resend"
            >
              {loading
                ? <ActivityIndicator size="small" color={c.ink} />
                : <Text style={styles.cancelButtonText}>Resend</Text>}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={() => navigation.goBack()}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Done"
              testID="delete-account-done"
            >
              <Text style={styles.cancelButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          disabled={loading}
          testID="delete-account-back"
        >
          <Ionicons name="chevron-back" size={22} color={c.amber} />
          <Text style={{ fontSize: 16, color: c.amber, marginLeft: 2 }}>Privacy</Text>
        </TouchableOpacity>
        <View style={styles.titleRow}>
          <Ionicons name="trash" size={18} color={c.red} />
          <Text style={styles.title}>Delete account</Text>
        </View>
        <Text style={styles.subtitle}>Read carefully. After 30 days this cannot be undone.</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Warning banner */}
        <View style={styles.warningBanner} testID="delete-account-warning">
          <Text style={styles.warningText}>
            We will email you a link first. Nothing is deleted until you confirm on that page.
            After you confirm you have 30 days to cancel the deletion from the email we send.
            Then your encrypted data is permanently shredded from all regions and there is
            nothing to recover, not for you, not for us, not for anyone with a court order.
          </Text>
        </View>

        {/* What gets destroyed */}
        <Text style={styles.sectionHeader}>What gets destroyed</Text>
        <View style={styles.card}>
          {DESTROYED_ITEMS.map(([label, detail], i) => (
            <View
              key={label}
              style={[styles.itemRow, i < DESTROYED_ITEMS.length - 1 && styles.itemRowBorder]}
            >
              <Ionicons name="trash-outline" size={12} color={c.ink3} style={{ marginRight: 10 }} />
              <Text style={styles.itemLabel}>{label}</Text>
              <Text style={styles.itemDetail}>{detail}</Text>
            </View>
          ))}
        </View>

        {/* Type DELETE */}
        <Text style={styles.label}>Type DELETE to confirm</Text>
        <TextInput
          style={styles.input}
          value={confirmation}
          onChangeText={setConfirmation}
          placeholder="DELETE"
          placeholderTextColor={c.ink4}
          autoCapitalize="characters"
          autoCorrect={false}
          spellCheck={false}
          editable={!loading}
          testID="delete-account-confirmation-input"
          accessibilityLabel="Type DELETE to confirm"
        />

        {/* Acknowledge checkbox */}
        <TouchableOpacity
          style={styles.checkRow}
          onPress={() => setUnderstood((v) => !v)}
          activeOpacity={0.7}
          disabled={loading}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: understood }}
          accessibilityLabel="I understand my files are encrypted and cannot be recovered after deletion"
          testID="delete-account-understood-checkbox"
        >
          <View style={[styles.checkbox, understood && styles.checkboxChecked]}>
            {understood && <Ionicons name="checkmark" size={14} color={c.paper} />}
          </View>
          <Text style={styles.checkLabel}>
            I understand my files are encrypted and cannot be recovered after deletion.
          </Text>
        </TouchableOpacity>

        {totpField}

        {error && (
          <View style={styles.errorBanner} testID="delete-account-error">
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Buttons */}
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.button, styles.cancelButton]}
            onPress={() => navigation.goBack()}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            testID="delete-account-cancel"
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.dangerButton, !canDelete && styles.buttonDisabled]}
            onPress={handleDelete}
            disabled={!canDelete}
            accessibilityRole="button"
            accessibilityLabel="Email me the deletion link"
            accessibilityState={{ disabled: !canDelete }}
            testID="delete-account-submit"
          >
            {loading
              ? <ActivityIndicator size="small" color={c.paper} />
              : <Text style={styles.dangerButtonText}>Email me the link</Text>
            }
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

function makeStyles(c: C, resolved: 'light' | 'dark', accessibilityLayout: boolean) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.paper },
    header: {
      paddingHorizontal: 14,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.line,
    },
    backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
    titleRow: {
      flexDirection: 'row',
      alignItems: accessibilityLayout ? 'flex-start' : 'center',
      flexWrap: accessibilityLayout ? 'wrap' : 'nowrap',
      gap: 8,
      marginTop: 4,
    },
    emailTitleRow: { marginTop: 12 },
    title: { fontSize: 22, fontWeight: '700', color: c.ink },
    subtitle: { fontSize: 12, color: c.ink3, marginTop: 2 },
    scrollContent: { paddingHorizontal: 14, paddingTop: spacing.md },
    warningBanner: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca',
      backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2',
      marginBottom: spacing.lg,
    },
    warningText: { fontSize: 12.5, lineHeight: 18, color: c.red },
    sectionHeader: {
      fontSize: 10,
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: c.ink3,
      marginBottom: 6,
    },
    card: {
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.paper,
      marginBottom: spacing.lg,
      overflow: 'hidden',
    },
    itemRow: {
      flexDirection: accessibilityLayout ? 'column' : 'row',
      alignItems: accessibilityLayout ? 'flex-start' : 'center',
      gap: accessibilityLayout ? 4 : 0,
      paddingVertical: 9,
      paddingHorizontal: 12,
    },
    itemRowBorder: { borderBottomWidth: 1, borderBottomColor: c.line },
    itemLabel: { fontSize: 13, color: c.ink, flex: accessibilityLayout ? undefined : 1 },
    itemDetail: { fontSize: 11, color: c.ink3, flexShrink: 1 },
    label: { fontSize: 12, fontWeight: '600', color: c.ink2, marginBottom: 6 },
    input: {
      minHeight: 44,
      borderWidth: 1,
      borderColor: c.line,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      fontSize: 14,
      fontWeight: '600',
      color: c.ink,
      backgroundColor: c.paper,
      marginBottom: spacing.md,
    },
    checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: spacing.lg },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: c.line2,
      backgroundColor: c.paper,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    checkboxChecked: { backgroundColor: c.red, borderColor: c.red },
    checkLabel: { flex: 1, fontSize: 12, color: c.ink2, lineHeight: 17 },
    errorBanner: {
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: radii.md,
      backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2',
      borderWidth: 1,
      borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca',
      marginBottom: spacing.md,
    },
    sentText: { fontSize: 13, color: c.ink2, lineHeight: 19, padding: 12 },
    sentNote: { fontSize: 12, color: c.ink3, marginBottom: spacing.md },
    errorText: { fontSize: 12, color: c.red, lineHeight: 17 },
    buttonRow: { flexDirection: accessibilityLayout ? 'column' : 'row', gap: 10 },
    button: {
      flex: accessibilityLayout ? undefined : 1,
      width: accessibilityLayout ? '100%' : undefined,
      minHeight: 46,
      paddingHorizontal: spacing.md,
      paddingVertical: 12,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelButton: { borderWidth: 1, borderColor: c.line, backgroundColor: c.paper },
    cancelButtonText: { fontSize: 14, fontWeight: '600', color: c.ink },
    dangerButton: { backgroundColor: c.red },
    dangerButtonText: { fontSize: 14, fontWeight: '700', color: c.paper },
    buttonDisabled: { opacity: 0.5 },
  });
}

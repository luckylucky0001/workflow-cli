// workctl demo Jenkins: admin account from the mounted secret file (never inlined).
// Core Jenkins only (no matrix-auth plugin): logged-in users have full control, anonymous has none.
import jenkins.model.Jenkins
import hudson.security.HudsonPrivateSecurityRealm
import hudson.security.FullControlOnceLoggedInAuthorizationStrategy

def instance = Jenkins.get()
def secret = new File('/run/secrets/jenkins_admin_password')
if (!secret.exists()) throw new IllegalStateException('missing /run/secrets/jenkins_admin_password (run demo/environment/up.sh)')
def realm = new HudsonPrivateSecurityRealm(false)
realm.createAccount('admin', secret.text.trim())
instance.setSecurityRealm(realm)
def strategy = new FullControlOnceLoggedInAuthorizationStrategy()
strategy.setAllowAnonymousRead(false)
instance.setAuthorizationStrategy(strategy)
instance.setNumExecutors(2)
instance.save()

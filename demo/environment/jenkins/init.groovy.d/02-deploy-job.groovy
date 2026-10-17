// Freestyle deploy job for demo-order (core Jenkins: no pipeline plugins).
// Parameters SERVICE / VERSION / ENV; the shell step "deploys" and fails when VERSION contains "bad".
import jenkins.model.Jenkins
import hudson.model.FreeStyleProject
import hudson.model.ParametersDefinitionProperty
import hudson.model.StringParameterDefinition
import hudson.tasks.Shell
import hudson.tasks.LogRotator

def instance = Jenkins.get()
def name = 'deploy-demo-order'
if (instance.getItem(name) == null) {
  def job = instance.createProject(FreeStyleProject, name)
  job.setDescription('workctl demo: deploy demo-order (synthetic)')
  job.addProperty(new ParametersDefinitionProperty([
    new StringParameterDefinition('SERVICE', 'demo-order', 'service id'),
    new StringParameterDefinition('VERSION', '', 'version / image tag to deploy'),
    new StringParameterDefinition('ENV', 'sandbox', 'target environment'),
  ]))
  job.getBuildersList().add(new Shell('''#!/bin/sh
echo "deploying ${SERVICE} version ${VERSION} to ${ENV}"
echo "image: workctl-demo/${SERVICE}:${VERSION}"
echo "registry token: ${DEPLOY_TOKEN:-dummy-token-not-a-secret}"
sleep 2
case "${VERSION}" in
  *bad*) echo "health check failed after rollout of ${VERSION}"; exit 1 ;;
esac
echo "deploy of ${SERVICE}:${VERSION} finished"
'''))
  // keep the last 20 builds (what workctl can see is bounded by this)
  job.setBuildDiscarder(new LogRotator(-1, 20, -1, -1))
  job.save()
}
